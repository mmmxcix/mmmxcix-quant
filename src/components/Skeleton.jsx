import { cn } from "@/lib/utils";

// A shimmering placeholder block for content that's loading. Size it with
// Tailwind width/height utilities via className (e.g. "h-4 w-16"). Decorative,
// so it's hidden from assistive tech. The shimmer collapses to a static tint
// under prefers-reduced-motion (see .skeleton in index.css).
export default function Skeleton({ className }) {
  return <span className={cn("skeleton block", className)} aria-hidden="true" />;
}
