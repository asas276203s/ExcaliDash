import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../../api";
import type { DrawingSortField, SortDirection } from "../../api";
import type { Collection, DrawingSummary } from "../../types";
import { isLatestRequest, mergeUniqueDrawings } from "./pagination";
import {
  buildDashboardListKey,
  getCachedDashboardList,
  setCachedDashboardList,
} from "./dashboardListCache";

type SelectedCollectionId = string | null | undefined;

type UseDashboardDataOptions = {
  debouncedSearch: string;
  selectedCollectionId: SelectedCollectionId;
  sortField: DrawingSortField;
  sortDirection: SortDirection;
  pageSize: number;
  onRefreshSuccess?: () => void;
};

export const useDashboardData = ({
  debouncedSearch,
  selectedCollectionId,
  sortField,
  sortDirection,
  pageSize,
  onRefreshSuccess,
}: UseDashboardDataOptions) => {
  const [drawings, setDrawings] = useState<DrawingSummary[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const listRequestVersionRef = useRef(0);
  const nextOffsetRef = useRef(0);

  const hasMore = drawings.length < totalCount;

  const refreshData = useCallback(async () => {
    const requestVersion = ++listRequestVersionRef.current;
    const cacheKey = buildDashboardListKey({
      view: selectedCollectionId,
      search: debouncedSearch,
      sortField,
      sortDirection,
      pageSize,
    });

    // Stale-while-revalidate: if we have this exact view cached, paint it
    // instantly (no spinner) and let the network fetch below revalidate it.
    const cached = getCachedDashboardList(cacheKey);
    if (cached) {
      setDrawings(cached.drawings);
      setTotalCount(cached.totalCount);
      setCollections(cached.collections);
      nextOffsetRef.current = cached.drawings.length;
      setIsLoading(false);
    } else {
      setIsLoading(true);
    }

    try {
      const isSharedView = selectedCollectionId === "shared";
      const drawingsPromise = isSharedView
        ? api.getSharedDrawings(debouncedSearch, {
            includePreview: true,
            limit: pageSize,
            offset: 0,
            sortField,
            sortDirection,
          })
        : api.getDrawings(debouncedSearch, selectedCollectionId, {
            includePreview: true,
            limit: pageSize,
            offset: 0,
            sortField,
            sortDirection,
          });

      const [drawingsResult, collectionsResult] = await Promise.allSettled([
        drawingsPromise,
        api.getCollections(),
      ]);
      if (!isLatestRequest(requestVersion, listRequestVersionRef.current))
        return;

      let freshDrawings: DrawingSummary[] | null = null;
      let freshTotalCount = 0;
      let freshCollections: Collection[] | null = null;

      if (drawingsResult.status === "fulfilled") {
        freshDrawings = drawingsResult.value.drawings;
        freshTotalCount = drawingsResult.value.totalCount;
        setDrawings(freshDrawings);
        setTotalCount(freshTotalCount);
        nextOffsetRef.current = freshDrawings.length;
        onRefreshSuccess?.();
      } else {
        console.error("Failed to fetch drawings:", drawingsResult.reason);
      }

      if (collectionsResult.status === "fulfilled") {
        freshCollections = collectionsResult.value;
        setCollections(freshCollections);
      } else {
        console.error("Failed to fetch collections:", collectionsResult.reason);
      }

      // Only cache a fully-successful first page so a switch-back can never
      // serve a half-populated view.
      if (freshDrawings !== null && freshCollections !== null) {
        setCachedDashboardList(cacheKey, {
          drawings: freshDrawings,
          totalCount: freshTotalCount,
          collections: freshCollections,
          cachedAt: Date.now(),
        });
      }
    } catch (err) {
      console.error("Failed to fetch data:", err);
    } finally {
      if (isLatestRequest(requestVersion, listRequestVersionRef.current)) {
        setIsLoading(false);
      }
    }
  }, [
    debouncedSearch,
    selectedCollectionId,
    pageSize,
    sortField,
    sortDirection,
    onRefreshSuccess,
  ]);

  const fetchMore = useCallback(async () => {
    if (isFetchingMore || !hasMore || isLoading) return;
    const requestVersion = listRequestVersionRef.current;
    setIsFetchingMore(true);
    try {
      const isSharedView = selectedCollectionId === "shared";
      const drawingsRes = await (isSharedView
        ? api.getSharedDrawings(debouncedSearch, {
            includePreview: true,
            limit: pageSize,
            offset: nextOffsetRef.current,
            sortField,
            sortDirection,
          })
        : api.getDrawings(debouncedSearch, selectedCollectionId, {
            includePreview: true,
            limit: pageSize,
            offset: nextOffsetRef.current,
            sortField,
            sortDirection,
          }));
      if (!isLatestRequest(requestVersion, listRequestVersionRef.current))
        return;
      setDrawings((prev) => mergeUniqueDrawings(prev, drawingsRes.drawings));
      setTotalCount(drawingsRes.totalCount);
      nextOffsetRef.current += drawingsRes.drawings.length;
    } catch (err) {
      console.error("Failed to fetch more data:", err);
    } finally {
      setIsFetchingMore(false);
    }
  }, [
    isFetchingMore,
    hasMore,
    isLoading,
    debouncedSearch,
    selectedCollectionId,
    pageSize,
    sortField,
    sortDirection,
  ]);

  useEffect(() => {
    refreshData();
  }, [refreshData]);

  return {
    drawings,
    setDrawings,
    collections,
    setCollections,
    totalCount,
    setTotalCount,
    isFetchingMore,
    isLoading,
    hasMore,
    refreshData,
    fetchMore,
  };
};
