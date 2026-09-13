import { Suspense } from "react";
import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { currentUser } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function SignupPage() {
  const user = await currentUser();
  if (user) redirect("/dashboard");
  return (
    <div className="aurora relative flex min-h-[80vh] items-center justify-center px-6 py-16">
      <div className="relative z-10 w-full">
        <Suspense>
          <AuthForm mode="signup" />
        </Suspense>
      </div>
    </div>
  );
}
