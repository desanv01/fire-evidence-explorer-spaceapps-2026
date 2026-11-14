/**
 * U07 browser file helpers. Kept local to the workbench so exports use one
 * implementation (downloads, printable reports, focus return) and never touch
 * the signed evidence-export route.
 */

export function downloadText(filename: string, text: string, mediaType = "application/json"): void {
  const blob = new Blob([text], { type: `${mediaType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4_000);
}

/** How long a successfully opened report keeps its blob URL alive to load. */
export const printReportUrlLifetimeMs = 60_000;

/**
 * Open the escaped printable report in a new tab; fall back to exactly one
 * download when the popup is blocked or its setup/navigation fails.
 *
 * This intentionally does not call `window.open(blobUrl, "_blank",
 * "noopener,noreferrer")`: the HTML Standard's window-open algorithm returns
 * null when a no-opener tab is created, so a successful open cannot be
 * distinguished from a blocked popup. Instead the print action synchronously
 * opens a same-origin blank tab (a returned handle proves the open succeeded),
 * disowns the opener, and only then navigates that tab to the escaped blob.
 * The blob URL is revoked after the new document has had time to load. When no
 * handle is returned, or disowning/navigating throws, any blank tab is closed,
 * the unused report URL is revoked, and the existing HTML download helper is
 * invoked once with the caller's filename.
 */
export function openPrintableReport(html: string, filename: string): "opened" | "downloaded" {
  let reportUrl: string | null = null;
  let opened: Window | null = null;
  try {
    reportUrl = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
    opened = window.open("about:blank", "_blank");
  } catch {
    opened = null;
  }

  if (!opened || !reportUrl) {
    if (reportUrl) URL.revokeObjectURL(reportUrl);
    downloadText(filename, html, "text/html");
    return "downloaded";
  }

  const printWindow = opened;
  const loadedUrl = reportUrl;
  try {
    // Disown the opener before the report document is navigated into this tab.
    printWindow.opener = null;
    if (printWindow.closed) throw new Error("The print tab closed before the report could be loaded.");
    printWindow.location.replace(loadedUrl);
  } catch {
    try {
      printWindow.close();
    } catch {
      // The blank tab may already be closed.
    }
    URL.revokeObjectURL(loadedUrl);
    downloadText(filename, html, "text/html");
    return "downloaded";
  }

  // The report document is loading; keep its blob URL alive until it settles.
  setTimeout(() => URL.revokeObjectURL(loadedUrl), printReportUrlLifetimeMs);
  return "opened";
}

export function errorMessage(error: unknown, fallback = "The operation could not be completed."): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** Return focus to a stable element after a transient panel or confirmation closes. */
export function focusElement(id: string): void {
  requestAnimationFrame(() => {
    const target = document.getElementById(id);
    target?.focus();
  });
}
