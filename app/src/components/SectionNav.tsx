import { Box } from "@mui/material";
import { Link } from "@tanstack/react-router";
import { STICKY_NAV_TOP } from "../lib/layout";

export interface SectionNavItem {
  key: string;
  label: string;
  icon: React.ReactNode;
}

/**
 * A page's left-hand nav: one entry per section, each of them a real URL.
 */
export function SectionNav({
  label,
  children,
}: {
  /** Names the landmark, so a page with two navs (this and the app bar's) has
   *  two distinguishable ones. */
  label: string;
  /** `SectionNavLink`s. */
  children: React.ReactNode;
}) {
  return (
    <Box
      component="nav"
      aria-label={label}
      data-testid="section-nav"
      sx={(theme) => ({
        display: "flex",
        flexDirection: { xs: "row", md: "column" },
        gap: 0.5,
        flexShrink: 0,
        minWidth: { md: 190 },
        maxWidth: "100%",
        overflowX: { xs: "auto", md: "visible" },
        pb: { xs: 0.5, md: 0 },
        position: { md: "sticky" },
        top: { md: STICKY_NAV_TOP },
        "& a": {
          display: "flex",
          alignItems: "center",
          gap: 1.25,
          flexShrink: 0,
          padding: "8px 12px",
          minHeight: 40,
          borderRadius: `${theme.shape.borderRadius}px`,
          border: "1px solid transparent",
          whiteSpace: "nowrap",
          fontSize: 13,
          fontWeight: 500,
          lineHeight: 1.3,
          textDecoration: "none",
          color: theme.palette.text.secondary,
          transition: "background-color 120ms, border-color 120ms, color 120ms",
          "& .MuiSvgIcon-root": { fontSize: 18, color: theme.palette.text.disabled },
          "&:hover": {
            backgroundColor: theme.palette.action.hover,
            color: theme.palette.text.primary,
            "& .MuiSvgIcon-root": { color: theme.palette.text.secondary },
          },
        },
        '& a[data-status="active"]': {
          backgroundColor: theme.palette.background.raised,
          borderColor: theme.palette.secondary.main,
          color: theme.palette.text.primary,
          fontWeight: 600,
          "& .MuiSvgIcon-root": { color: theme.palette.secondary.main },
        },
      })}
    >
      {children}
    </Box>
  );
}

/**
 * The anchor a section nav entry is.
 *
 * A bare re-export of TanStack's `Link` — no wrapper, no `styled`, precisely so
 * `to` and `params` keep the router's own types (see `SectionNav`'s docblock).
 * It is re-exported under this name anyway so a call site reads as what it is
 * and so there is one obvious thing to put inside a `SectionNav`.
 */
export const SectionNavLink = Link;
