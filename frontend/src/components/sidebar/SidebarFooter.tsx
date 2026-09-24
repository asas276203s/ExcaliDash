import React, { useState } from "react";
import {
  Shield,
  Settings as SettingsIcon,
  Trash2,
  User,
  LogOut,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import clsx from "clsx";
import { getInitialsFromName } from "../../utils/user";

type UserLike =
  | {
      name: string;
      email: string;
      role?: string;
    }
  | null
  | undefined;

interface SidebarFooterProps {
  selectedCollectionId: string | null | undefined;
  authEnabled: boolean | null;
  user: UserLike;
  onDrop?: (e: React.DragEvent, collectionId: string | null) => void;
  onLogout: () => void;
}

const iconButtonClass =
  "flex items-center justify-center h-9 rounded-xl transition-all duration-200 border-2 border-black dark:border-neutral-700 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,0.2)] cursor-pointer";

const iconButtonTone = (isActive: boolean) =>
  isActive
    ? "bg-indigo-50 dark:bg-neutral-800 text-indigo-900 dark:text-neutral-200 -translate-y-0.5"
    : "bg-white dark:bg-neutral-900 text-slate-900 dark:text-neutral-200 hover:bg-slate-50 dark:hover:bg-neutral-800 hover:-translate-y-0.5";
export const SidebarFooter: React.FC<SidebarFooterProps> = ({
  selectedCollectionId,
  authEnabled,
  user,
  onDrop,
  onLogout,
}) => {
  const navigate = useNavigate();
  const [isTrashDragOver, setIsTrashDragOver] = useState(false);
  const isAdmin = user?.role === "ADMIN";

  return (
    <div className="px-3 pt-3 sm:pt-4 pb-3 sm:pb-4 border-t border-slate-200/50 dark:border-slate-700/50 space-y-2">
      {/* Four full-width rows ate most of the sidebar's lower half. One icon
          row does the same job: Trash keeps its drop handlers (dragging a
          drawing onto it still works), the rest are one click as before. */}
      <div className="grid grid-flow-col auto-cols-fr gap-2">
        <button
          type="button"
          title="Trash"
          aria-label="Trash"
          onDragOver={(e) => {
            e.preventDefault();
            setIsTrashDragOver(true);
          }}
          onDragLeave={() => setIsTrashDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsTrashDragOver(false);
            onDrop?.(e, "trash");
          }}
          onClick={() => navigate("/collections?id=trash")}
          className={clsx(
            iconButtonClass,
            selectedCollectionId === "trash" || isTrashDragOver
              ? "bg-rose-50 dark:bg-rose-900/30 text-rose-900 dark:text-rose-300 -translate-y-0.5"
              : "bg-white dark:bg-neutral-900 text-slate-900 dark:text-neutral-200 hover:bg-rose-50 dark:hover:bg-rose-900/30 hover:text-rose-900 dark:hover:text-rose-300 hover:-translate-y-0.5",
          )}
        >
          <Trash2 size={18} />
        </button>

        {authEnabled && (
          <button
            type="button"
            title="Profile"
            aria-label="Profile"
            onClick={() => navigate("/profile")}
            className={clsx(
              iconButtonClass,
              iconButtonTone(selectedCollectionId === "PROFILE"),
            )}
          >
            <User size={18} />
          </button>
        )}

        {authEnabled && isAdmin && (
          <button
            type="button"
            title="Admin"
            aria-label="Admin"
            onClick={() => navigate("/admin")}
            className={clsx(
              iconButtonClass,
              iconButtonTone(selectedCollectionId === "ADMIN"),
            )}
          >
            <Shield size={18} />
          </button>
        )}

        <button
          type="button"
          title="Settings"
          aria-label="Settings"
          onClick={() => navigate("/settings")}
          className={clsx(
            iconButtonClass,
            iconButtonTone(selectedCollectionId === "SETTINGS"),
          )}
        >
          <SettingsIcon size={18} />
        </button>
      </div>

      {authEnabled && (
        <div className="mt-auto pt-4 border-t-2 border-slate-200 dark:border-neutral-700">
          {user && (
            <div className="py-2 text-xs text-slate-500 dark:text-neutral-500 mb-2">
              <div className="grid grid-cols-[auto_1fr_auto] items-center gap-3">
                <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-indigo-600 text-white font-bold flex items-center justify-center">
                  {getInitialsFromName(user.name)}
                </div>
                <div className="min-w-0 text-left">
                  <div className="font-semibold text-slate-700 dark:text-neutral-300 truncate leading-tight">
                    {user.name}
                  </div>
                  <div className="truncate leading-tight">{user.email}</div>
                </div>
                <div
                  className="w-7 h-7 sm:w-8 sm:h-8 invisible"
                  aria-hidden="true"
                />
              </div>
            </div>
          )}
          <button
            onClick={onLogout}
            className="w-full flex items-center gap-3 px-3 py-2 text-sm font-bold rounded-xl transition-all duration-200 border-2 border-rose-300 dark:border-rose-700 bg-white dark:bg-neutral-900 text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-900/30 hover:shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:hover:shadow-[2px_2px_0px_0px_rgba(255,255,255,0.2)] hover:-translate-y-0.5 cursor-pointer"
          >
            <LogOut size={18} />
            <span className="min-w-0 flex-1 text-left">Logout</span>
          </button>
        </div>
      )}
    </div>
  );
};
