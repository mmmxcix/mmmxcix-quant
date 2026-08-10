// SkipLink — WCAG 2.4.1 (Bypass Blocks). A keyboard user should not have to
// tab through the whole sidebar, tab bar and toolbar on every single page just
// to reach the content. This is the first thing in the DOM, invisible until it
// takes focus, and jumps straight to <main>.
//
// It must be a real <a href="#…">: browsers move focus AND the reading cursor
// for a link to a fragment, which a button + scrollIntoView does not do.
export default function SkipLink({ targetId = "main-content" }) {
  return (
    <a href={`#${targetId}`} className="skip-link">
      Skip to main content
    </a>
  );
}
