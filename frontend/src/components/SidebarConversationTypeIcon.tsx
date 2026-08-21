interface SidebarConversationTypeIconProps {
  type: "general" | "paper";
}

/** Theme-aware line icon used to distinguish chat and paper rows at a glance. */
export function SidebarConversationTypeIcon({ type }: SidebarConversationTypeIconProps) {
  return (
    <span className={`conv-type-icon ${type}`} aria-hidden={true}>
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
        focusable="false"
      >
        {type === "general" ? (
          <>
            <path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2Z" />
            <path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1" />
          </>
        ) : (
          <>
            <path d="M12 7v14" />
            <path d="M3 18a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3Z" />
            <path d="M21 18a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1h-5a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3Z" />
          </>
        )}
      </svg>
    </span>
  );
}
