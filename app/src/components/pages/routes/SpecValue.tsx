import { Box, Tooltip } from "@mui/material";
import type { Theme } from "@mui/material/styles";
import type { SxProps } from "@mui/material/styles";

/**
 * One value of the route header's spec, and the hover ground under it.
 *
 * Its own file only because `RouteHeader` and `RouteFilterChips` both render one
 * and the chips are rendered BY the header — leaving it where it was would be an
 * import cycle.
 */

/** An unset filter, and the one other thing that is stated while off: alerts.
 *  `text.disabled` on a `divider` border is quiet enough that a strip of them
 *  reads as offers rather than as facts about the route. */
export const MUTED_CHIP_SX: SxProps<Theme> = {
  color: "text.disabled",
  borderColor: "divider",
};

/**
 * A bare value with its label in a tooltip.
 *
 * Unlabelled: the values are self-describing (a date range, cabin chips, card
 * marks) and the sentence explaining each is one hover away, on the value itself
 * rather than as a caption above it.
 */
export function SpecValue({
  help,
  hint = "Click to edit.",
  onClick,
  expanded,
  pressed,
  ref,
  testId,
  children,
}: {
  help: string;
  /** The second tooltip line, naming what a click does. Default for a value that
   *  opens the edit dialog; a chip that edits in place says so instead. */
  hint?: string;
  /** Makes the value a control. Every value here is a setting, so the header
   *  doubles as its own table of contents — you read a setting and touch it in
   *  one move. */
  onClick?: () => void;
  /** This value's popover is open. Suppresses the tooltip, which would otherwise
   *  hover over the surface it just opened. */
  expanded?: boolean;
  /** For a value that toggles in place rather than opening anything. */
  pressed?: boolean;
  /** The hover ground itself, so a popover anchors where the click landed. */
  ref?: React.Ref<HTMLDivElement>;
  testId?: string;
  children: React.ReactNode;
}) {
  return (
    <Tooltip
      title={
        expanded ? (
          ""
        ) : onClick ? (
          <>
            {help}
            <Box component="span" sx={{ display: "block", mt: 0.5, opacity: 0.75 }}>
              {hint}
            </Box>
          </>
        ) : (
          help
        )
      }
      placement="bottom-start"
    >
      <Box
        ref={ref}
        data-testid={testId}
        // A Box with a role, never a `<button>`: MUI `Chip` renders a `div`, and
        // a div inside a button is invalid HTML that browsers reflow around.
        role={onClick ? "button" : undefined}
        tabIndex={onClick ? 0 : undefined}
        aria-expanded={expanded}
        aria-pressed={pressed}
        onClick={onClick}
        onKeyDown={
          onClick
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onClick();
                }
              }
            : undefined
        }
        sx={{
          minWidth: 0,
          display: "flex",
          flexWrap: "wrap",
          gap: 0.5,
          alignItems: "center",
          cursor: onClick ? "pointer" : "help",
          // Negative margin against the padding, so the hover ground has room
          // around the value without widening the row when nothing is hovered —
          // this strip is sticky and must not move as the pointer crosses it.
          ...(onClick && {
            px: 0.5,
            mx: -0.5,
            py: 0.25,
            my: -0.25,
            transition: "background-color 120ms",
            "&:hover": { bgcolor: (t: Theme) => t.spec.hover },
            "&:focus-visible": {
              outline: "1px solid",
              outlineColor: (t: Theme) => t.spec.indicator,
              outlineOffset: 0,
            },
          }),
        }}
      >
        {children}
      </Box>
    </Tooltip>
  );
}
