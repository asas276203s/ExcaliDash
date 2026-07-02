import React, {
  createContext,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import { useLocation, useMatch } from "react-router-dom";
import {
  useTabs,
  type UseTabsResult,
  type EditorTab,
} from "../pages/editor/useTabs";

// Hoisted tab state so the tab bar can live in the Layout (visible on
// Dashboard, Settings, Admin, Editor — everywhere protected) and not only
// on the Editor page. The context reads the current /editor/:id param via
// react-router so tab activation still follows navigation.

export interface TabsContextValue extends UseTabsResult {
  /** Path route pattern under which the tab bar should render. When null the
   * layout hides the tab bar (auth pages, etc.). */
  visible: boolean;
  /** Drawing id currently in the URL, or undefined off the editor route. */
  currentDrawingId: string | undefined;
}

const TabsContext = createContext<TabsContextValue | null>(null);

/** Routes on which the tab bar should never render. */
const HIDDEN_ROUTES = [
  "/login",
  "/register",
  "/reset-password",
  "/reset-password-confirm",
  "/auth-setup",
];

export const TabsProvider: React.FC<{ children: ReactNode }> = ({
  children,
}) => {
  const location = useLocation();
  const editorMatch = useMatch("/editor/:id");
  const currentDrawingId = editorMatch?.params?.id;
  const tabsApi = useTabs(currentDrawingId);
  const visible = !HIDDEN_ROUTES.some((r) => location.pathname.startsWith(r));

  const value = useMemo<TabsContextValue>(
    () => ({ ...tabsApi, currentDrawingId, visible }),
    [tabsApi, currentDrawingId, visible],
  );

  return <TabsContext.Provider value={value}>{children}</TabsContext.Provider>;
};

export const useTabsContext = (): TabsContextValue => {
  const ctx = useContext(TabsContext);
  if (!ctx) {
    throw new Error("useTabsContext must be used inside <TabsProvider>");
  }
  return ctx;
};

export type { EditorTab };
