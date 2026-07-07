import React from "react";
import { toast } from "sonner";
import { diagnostics } from "../lib/diagnostics";

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  errorMessage: string | null;
  reporting: boolean;
  reported: boolean;
}

/**
 * Error boundary around the drawing editor. When the React subtree crashes
 * (the "白屏" / blank-canvas failure), it:
 *   1. logs the error + component stack to the diagnostics ring buffer,
 *   2. immediately flushes the buffer to the backend bug tracker, and
 *   3. renders a self-contained Traditional-Chinese fallback (no canvas
 *      dependency) with reload + "回報問題" actions.
 *
 * The fallback deliberately avoids touching Excalidraw or any editor state so
 * it still renders even when the canvas itself is what broke.
 */
export class EditorErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      errorMessage: null,
      reporting: false,
      reported: false,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, errorMessage: error?.message ?? "Unknown error" };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    diagnostics.log(
      "react-error-boundary",
      {
        message: error?.message ?? null,
        stack: error?.stack ?? null,
        componentStack: info?.componentStack ?? null,
      },
      "error",
    );
    // Auto-flush the trace so an operator can see the crash without the user
    // having to do anything.
    void diagnostics.flush("error-boundary").then((ok) => {
      if (ok) this.setState({ reported: true });
    });
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  private handleReport = async (): Promise<void> => {
    this.setState({ reporting: true });
    const ok = await diagnostics.flush("manual-error-boundary");
    this.setState({ reporting: false, reported: ok || this.state.reported });
    if (ok) {
      toast.success("已送出診斷資料、感謝回報");
    } else {
      toast.error("診斷資料送出失敗、請稍後再試");
    }
  };

  render(): React.ReactNode {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="h-screen w-full flex flex-col items-center justify-center gap-5 bg-white dark:bg-neutral-950 px-6 text-center">
        <div className="max-w-md">
          <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100">
            畫布發生錯誤
          </h2>
          <p className="mt-3 text-sm text-gray-600 dark:text-gray-400">
            編輯器遇到未預期的問題而中斷。你的最近變更多半已自動儲存。
            請重新載入頁面繼續；若問題重複發生，按「回報問題」把診斷資料傳給我們協助排查。
          </p>
          {this.state.reported && (
            <p className="mt-2 text-xs text-emerald-600 dark:text-emerald-400">
              診斷資料已自動送出。
            </p>
          )}
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={this.handleReload}
            className="px-4 py-2 rounded-lg border-2 border-black dark:border-neutral-700 bg-white dark:bg-neutral-900 text-gray-900 dark:text-gray-100 font-semibold hover:bg-gray-50 dark:hover:bg-neutral-800 transition-colors"
          >
            重新載入
          </button>
          <button
            type="button"
            onClick={this.handleReport}
            disabled={this.state.reporting}
            className="px-4 py-2 rounded-lg bg-indigo-600 text-white font-semibold hover:bg-indigo-700 disabled:opacity-60 transition-colors"
          >
            {this.state.reporting ? "傳送中…" : "回報問題"}
          </button>
        </div>
      </div>
    );
  }
}
