import type { ComponentProps } from "react";
import { useNavigate } from "react-router-dom";

import { TaskDetail } from "./TaskDetail";

/** The detail panel with "open linked note" wired to the router (deep link `/notes?open=`, MU-05). */
export function RoutedTaskDetail(props: ComponentProps<typeof TaskDetail>) {
  const navigate = useNavigate();
  const { onClose } = props;
  return (
    <TaskDetail
      {...props}
      onOpenNote={(noteId) => {
        // Notes live on their own page: close the panel, then follow the deep link.
        onClose();
        navigate(`/notes?open=${encodeURIComponent(noteId)}`);
      }}
    />
  );
}
