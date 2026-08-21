import type { ReactNode } from "react";

type SidebarActionIconName =
  | "expand-sidebar"
  | "collapse-sidebar"
  | "new-chat"
  | "open-paper"
  | "settings"
  | "log-out";

interface SidebarActionIconProps {
  name: SidebarActionIconName;
}

/** Theme-aware line icons for sidebar actions.
 *  The owning Tooltip or visible button text supplies the accessible name, so
 *  these SVGs stay decorative and cannot create a duplicate screen-reader label. */
export function SidebarActionIcon({ name }: SidebarActionIconProps) {
  let icon: ReactNode;

  switch (name) {
    case "expand-sidebar":
      icon = (
        <>
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M9 3v18" />
          <path d="m14 9 3 3-3 3" />
        </>
      );
      break;
    case "collapse-sidebar":
      icon = (
        <>
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M9 3v18" />
          <path d="m16 9-3 3 3 3" />
        </>
      );
      break;
    case "new-chat":
      icon = (
        <>
          <path d="M12 5v14" />
          <path d="M5 12h14" />
        </>
      );
      break;
    case "open-paper":
      icon = (
        <>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
          <path d="M9 15h6" />
          <path d="M12 12v6" />
        </>
      );
      break;
    case "settings":
      icon = (
        <>
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.51a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
          <circle cx="12" cy="12" r="3" />
        </>
      );
      break;
    case "log-out":
      icon = (
        <>
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
          <path d="m16 17 5-5-5-5" />
          <path d="M21 12H9" />
        </>
      );
      break;
  }

  return (
    <svg
      className={"sidebar-action-icon sidebar-action-icon--" + name}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === "new-chat" ? 2.4 : 2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={true}
      focusable="false"
    >
      {icon}
    </svg>
  );
}
