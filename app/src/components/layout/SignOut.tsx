import { useQueryClient } from "@tanstack/react-query";
import { IconButton, Tooltip } from "@mui/material";
import LogoutRoundedIcon from "@mui/icons-material/LogoutRounded";
import { api } from "../../api";
import { notifyLocked } from "../../lib/auth";

/**
 * Sign out.
 *
 * The session is an HttpOnly cookie, so only the Worker can actually clear it —
 * hence the round trip. `notifyLocked` is then the same hand-off a 401 uses
 * (`app/src/lib/auth.ts`), so signing out and being timed out land on exactly one
 * code path.
 *
 * It runs BEFORE `queryClient.clear()`, and the order is not cosmetic: locking
 * first unmounts the app, so clearing the cache can't set every still-mounted
 * panel refetching against a session that no longer exists. The clear itself is
 * required — leaving it out would render a signed-out app full of the previous
 * session's data the moment anyone signed back in.
 */
export function SignOut() {
  const queryClient = useQueryClient();
  return (
    <Tooltip title="Sign out">
      <IconButton
        size="small"
        aria-label="Sign out"
        onClick={async () => {
          await api.logout();
          notifyLocked();
          queryClient.clear();
        }}
      >
        <LogoutRoundedIcon fontSize="small" />
      </IconButton>
    </Tooltip>
  );
}