import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="mt-28 border-t border-line">
      <div className="mx-auto grid max-w-6xl gap-8 px-6 py-12 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <div className="flex items-center gap-2 font-semibold">
            <span className="text-gradient text-lg">Swarmproof</span>
          </div>
          <p className="mt-3 max-w-xs text-sm leading-relaxed text-mist">
            The bug bounty protocol where accepted findings pay from escrow the client can&apos;t claw
            back. Any chain, any currency.
          </p>
        </div>
        <FooterCol
          title="Product"
          links={[
            { href: "/programs", label: "Programs" },
            { href: "/tools", label: "Tools" },
            { href: "/dashboard", label: "Dashboard" },
            { href: "/programs/new", label: "Start a program" },
          ]}
        />
        <FooterCol
          title="Learn"
          links={[
            { href: "/how", label: "How it works" },
            { href: "/tools", label: "Hunter toolkit" },
            { href: "https://github.com/allisonbit/bug-protocol", label: "Contracts (GitHub)" },
          ]}
        />
        <FooterCol
          title="Get started"
          links={[
            { href: "/signup", label: "Create account" },
            { href: "/login", label: "Log in" },
          ]}
        />
      </div>
      <div className="border-t border-line px-6 py-6">
        <p className="mx-auto max-w-6xl text-xs text-mist">
          Swarmproof is protocol software. Payments settle in whatever currency a client funds.
        </p>
      </div>
    </footer>
  );
}

function FooterCol({ title, links }: { title: string; links: { href: string; label: string }[] }) {
  return (
    <div>
      <div className="text-xs font-medium tracking-widest text-mist uppercase">{title}</div>
      <ul className="mt-3 space-y-2">
        {links.map((l) => (
          <li key={l.href + l.label}>
            <Link href={l.href} className="text-sm text-mist transition-colors hover:text-chalk">
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
