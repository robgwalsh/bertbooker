import { Box } from "@mui/material";
import { GUTTERS, PAGE_PY } from "../lib/layout";

/**
 * The padded, scrolling page body — what a page that is a DOCUMENT sits in.
 *
 * `Layout` deliberately does not pad or scroll: the Routes page is a workbench
 * that runs edge to edge with its own panes, and a shell that padded everything
 * would have to be fought with negative margins to get there. So the shell
 * hands each page a full-height box and the pages that want a margin ask for
 * one here.
 *
 * It is also the scroll container, which is what keeps exactly one scrollbar on
 * screen: the document can't scroll (`html, body, #root` are all 100%), so a
 * page that didn't scroll internally would simply clip.
 */
export function PagePad({ children }: { children: React.ReactNode }) {
  return (
    // This box owns BOTH axes. `overflowY` was always here; `overflowX` matters
    // because the document itself cannot scroll (`html, body, #root` are 100%),
    // so without a scroller of its own a child wider than the viewport paints
    // off the edge of the screen with nothing anywhere that can reach it.
    //
    // `auto` rather than `hidden`, and the difference is about how a future
    // mistake surfaces: clipping would HIDE an over-wide child, including from
    // `e2e/mobile.spec.ts`, which catches exactly this by comparing
    // `scrollWidth` to `clientWidth`. Scrolling makes the same mistake visible
    // in the app and fails the test. Nothing should be reaching it today — the
    // wide tables carry their own `TableContainer` scroller and become cards on
    // a phone — so this is a backstop, not a layout.
    <Box sx={{ height: "100%", overflowY: "auto", overflowX: "auto", py: PAGE_PY, px: GUTTERS }}>
      {children}
    </Box>
  );
}