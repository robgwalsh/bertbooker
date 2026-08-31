import { styled } from "@mui/material";
import { Link } from "@tanstack/react-router";

/**
 * A page, drawn as an editor tab.
 */
export const NavLink = styled(Link)(({ theme }) => ({
  display: "flex",
  alignItems: "center",
  padding: "0 8px",
  [theme.breakpoints.up("sm")]: { padding: "0 16px" },
  whiteSpace: "nowrap",
  fontSize: 13,
  fontWeight: 500,
  textDecoration: "none",
  color: theme.spec.tabIdleText,
  borderRight: `1px solid ${theme.palette.divider}`,
  borderTop: "2px solid transparent",
  marginBottom: -1,
  borderBottom: "1px solid transparent",
  "&:hover": {
    color: theme.palette.text.primary,
    backgroundColor: theme.spec.tabHover,
  },
  '&[data-status="active"]': {
    color: theme.palette.text.primary,
    backgroundColor: theme.palette.background.default,
    borderTopColor: theme.spec.indicator,
    borderBottomColor: theme.palette.background.default,
  },
}));