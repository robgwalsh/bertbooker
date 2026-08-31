import { Box } from "@mui/material";
import { GUTTERS, PAGE_PY } from "../lib/layout";

/**
 * The padded, scrolling page body for pages that want padding.
 */
export function PagePad({ children }: { children: React.ReactNode }) {
  return (    
    <Box sx={{ height: "100%", overflowY: "auto", overflowX: "auto", py: PAGE_PY, px: GUTTERS }}>
      {children}
    </Box>
  );
}