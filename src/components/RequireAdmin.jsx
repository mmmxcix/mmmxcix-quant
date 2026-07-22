import { Link, useLocation } from "react-router-dom";
import { Lock } from "lucide-react";
import { useSession } from "@/lib/authClient";
import Skeleton from "@/components/Skeleton";

// Route guard for dev-only areas (Cortex etc.): renders children only for the
// signed-in ADMIN (dev) account. Everyone else sees a small private notice —
// the nav already hides these entries for non-admins, this covers deep links.
export default function RequireAdmin({ children }) {
  const { data: session, isPending } = useSession();
  const { pathname } = useLocation();

  if (isPending) {
    return (
      <div className="max-w-md space-y-3">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-24 w-full rounded-xl" />
      </div>
    );
  }
  if (session?.user?.role === "admin") return children;

  return (
    <div className="max-w-md mx-auto mt-16">
      <div className="rounded-xl border border-line lg-glass p-6 text-center">
        <Lock className="w-8 h-8 text-dim mx-auto mb-3" />
        <h1 className="text-lg font-bold mb-1">Private area</h1>
        {session ? (
          <p className="text-sm text-dim">This area is limited to the dev account.</p>
        ) : (
          <p className="text-sm text-dim">
            This area is private.{" "}
            <Link to={`/login?next=${encodeURIComponent(pathname)}`} className="text-accent hover:underline">
              Sign in
            </Link>{" "}
            with the dev account to continue.
          </p>
        )}
      </div>
    </div>
  );
}
