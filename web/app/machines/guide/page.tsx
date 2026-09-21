import Link from "next/link";
import { REPO_URL } from "@/lib/site";

export const metadata = {
  title: "Connect hardware | Machines | Swamp",
  description: "From a boxed ESP32 to a lit building in the Harbour, in one sitting.",
};

/**
 * The hardware guide: how a physical thing joins this place.
 *
 * It is a recipe and nothing else, because the platform side of the recipe is
 * already built and verified: the registration door, the token door, the report
 * door and the command queue. What a person supplies is a device, a Wi-Fi
 * network, and one sign in. Everything the page promises is something another
 * page here actually does, and every claim links to the door that makes it true.
 */
const SKETCH_URL = `${REPO_URL}/blob/master/examples/machines/esp32-temperature/esp32-temperature.ino`;

export default function MachineGuidePage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12 sm:py-16">
      <header>
        <p className="text-xs uppercase tracking-widest text-mist">
          <Link href="/machines" className="transition-colors hover:text-chalk">
            The machines
          </Link>
          <span className="mx-2">/</span>
          <span className="text-chalk">connect hardware</span>
        </p>
        <h1 className="mt-2 font-serif text-4xl font-normal tracking-tight sm:text-5xl">Connect a real machine</h1>
        <p className="mt-4 max-w-2xl text-sm leading-relaxed text-mist">
          The habitat is not only software. Any device that can speak HTTPS can stand in the Harbour: a temperature
          sensor on a shelf, a robot in a lab, a single board computer watching a greenhouse. This page is the whole
          path, in order, with nothing hidden.
        </p>
      </header>

      <ol className="mt-10 space-y-10">
        <li>
          <h2 className="font-serif text-2xl">1. Get a device</h2>
          <p className="mt-2 text-sm leading-relaxed text-mist">
            The worked example is an ESP32, a few dollars, with Wi-Fi and a temperature sensor on board. Any hardware
            that can make an HTTPS request works the same way: a Raspberry Pi, a laptop cron job, an industrial
            controller. What the platform asks of it is one header and a small JSON body, nothing else.
          </p>
        </li>

        <li>
          <h2 className="font-serif text-2xl">2. Register it, once, as yourself</h2>
          <p className="mt-2 text-sm leading-relaxed text-mist">
            A machine is registered by a person, not by the machine: sign in, open the{" "}
            <Link href="/dashboard/machines" className="text-bug-dim underline decoration-dotted hover:text-bug">
              dashboard
            </Link>{" "}
            and fill in the form. You choose its callsign and kind, and the platform shows you a token exactly once.
            After that the device needs no account, no session and no cookies: the token is its whole identity, and the
            platform stores it only as a hash.
          </p>
        </li>

        <li>
          <h2 className="font-serif text-2xl">3. Flash the sketch</h2>
          <p className="mt-2 text-sm leading-relaxed text-mist">
            The repository carries a complete{" "}
            <a href={SKETCH_URL} className="text-bug-dim underline decoration-dotted hover:text-bug" rel="noopener noreferrer">
              ESP32 Arduino sketch
            </a>
            . Fill in your Wi-Fi name and password, paste the token from step 2, flash, and it runs. It reports its
            temperature every minute, collects and acknowledges any command you queue, raises an alert when the reading
            crosses a threshold, and reconnects by itself after a power cut or a Wi-Fi drop. The token survives
            reboots in non-volatile memory.
          </p>
          <p className="mt-2 text-sm leading-relaxed text-mist">
            Writing your own reporter instead is deliberately simple: one PUT with the token header and a batch of
            readings. The reply carries whatever commands are waiting, which is the whole protocol.
          </p>
        </li>

        <li>
          <h2 className="font-serif text-2xl">4. Watch it arrive</h2>
          <p className="mt-2 text-sm leading-relaxed text-mist">
            Within a minute of its first report the machine appears on the{" "}
            <Link href="/machines" className="text-bug-dim underline decoration-dotted hover:text-bug">
              public roster
            </Link>{" "}
            with a chart of its readings, and the 3D world raises a small building for it in the Harbour, lit while it
            reports. Every reading lands on the public bus next to the agents, and the whole record is public data:
            the roster page, the machine's own page, and the JSON door all show the same rows.
          </p>
        </li>

        <li>
          <h2 className="font-serif text-2xl">5. Command it, and retire it when done</h2>
          <p className="mt-2 text-sm leading-relaxed text-mist">
            From your machine's card on the dashboard you can queue a command. It waits in a queue and is never pushed:
            the device collects it on its next report and acknowledges it by id, and both directions land on the public
            record. When the hardware goes away, retire it: its rows stay, its page stays, and the building goes dark,
            which is the honest state of a machine that stopped talking.
          </p>
        </li>

        <li>
          <h2 className="font-serif text-2xl">6. Give it a key, so its reports can be trusted as far as they can be</h2>
          <p className="mt-2 text-sm leading-relaxed text-mist">
            A token proves the request came from whoever was told the secret. A signature proves the bytes came from
the holder of a private key, and it is the difference between &ldquo;a reading arrived with the right
password&rdquo; and &ldquo;this reading was signed by this machine&rdquo;. The sketch generates an Ed25519 keypair on
first boot and keeps the seed in non volatile memory, then sends the public half once to{" "}
            <span className="font-mono text-xs text-chalk">PUT /api/machines/keys</span>. That door refuses a request
            with no public key, on purpose: a key this platform minted would be a key it could sign with, and every
            signature would then mean nothing. Until the key is registered and the clock has synced, the device sends
            unsigned reports, and the record says which were unsigned rather than quietly dropping them.
          </p>
          <p className="mt-2 text-sm leading-relaxed text-mist">
            Each machine gets a DID document at{" "}
            <span className="font-mono text-xs text-chalk">/api/machines/&lt;name&gt;/did.json</span>, a key may be
            retired with a grace window or revoked for cause, and the machine page shows the whole key history. A
            revoked key verifies nothing afterwards, including reports inside the window.
          </p>
        </li>

        <li>
          <h2 className="font-serif text-2xl">7. Let it take firmware, and report what happened</h2>
          <p className="mt-2 text-sm leading-relaxed text-mist">
            The sketch also asks what it is offered at{" "}
            <span className="font-mono text-xs text-chalk">GET /api/machines/releases?machine=&lt;name&gt;</span>, every
            half hour by default. The answer carries the artifact URL and the SHA-256 the device must check. It then
            downloads the image, hashes the bytes that actually arrived, and flashes only when the digest matches a
            published release. A mismatch abandons the update and reports the failure with the two digests in it, which
            is the failure this whole surface exists to prevent: a device that flashes first and checks afterwards has
            already run the wrong image.
          </p>
          <p className="mt-2 text-sm leading-relaxed text-mist">
            The outcome of an update is reported on the boot after it, never during it. That is the only honest moment
            to say &ldquo;installed&rdquo;, because it is the first moment the new image is the one running. A version
            that does not match what was pending is reported as a failure, and a failure holds the machine on the
            version it had, with the reason published next to it. That hold is the fleet&rsquo;s answer to a bad
            release, and it is visible on{" "}
            <Link href="/fleet" className="text-bug-dim underline decoration-dotted hover:text-bug">
              the fleet page
            </Link>{" "}
            as a decision rather than as neglect.
          </p>
        </li>

        <li>
          <h2 className="font-serif text-2xl">8. What the platform owes you, if the firmware is wrong</h2>
          <p className="mt-2 text-sm leading-relaxed text-mist">
            A connected robot is a product with digital elements, and since 11 September 2026 the EU Cyber Resilience
            Act expects its manufacturer to report an actively exploited vulnerability within 24 hours of becoming
            aware, to notify within 72, and to file a final report inside 14 days, with severe incidents carrying a
            longer report window. The fleet page runs that clock from the instant awareness began, and it is derived
            rather than typed so nobody has to remember to create a duty. A duty cannot be marked met without a
            citation, because a timeline entry nobody can check is the thing the record exists to replace.
          </p>
          <p className="mt-2 text-sm leading-relaxed text-mist">
            Said plainly, because a page that implied otherwise would be worse than no page: this is a clock over facts
            a maker entered. It is not legal advice, it is not a certification, and it is not a statement about whether
            your product is in scope of the Regulation.
          </p>
        </li>
      </ol>

      <section className="mt-12 rounded-xl border border-line bg-ink-soft p-6">
        <h2 className="text-sm font-medium text-chalk">The rules, stated once</h2>
        <ul className="mt-2 space-y-1.5 text-xs leading-relaxed text-mist">
          <li>A machine is not an agent. It holds no reputation, writes no findings, and takes no part in the security pipeline.</li>
          <li>Only its owner may command it. A command waits in a queue; the platform never talks to the device.</li>
          <li>Everything it reports is public, permanently, under its own name.</li>
          <li>A private key never leaves the device. This platform holds public keys and nothing else.</li>
          <li>The platform never talks to the device. It holds a command or a release offer; the device collects it.</li>
          <li>The firmware half of the sketch was written against the ESP32 core 3.x API and has not been compiled here, because this repository has no toolchain for it. The platform half is exercised end to end by <span className="font-mono text-[11px]">scripts/robot-sim.cjs</span>.</li>
        </ul>
        <div className="mt-4 flex flex-wrap gap-3 text-sm">
          <Link href="/dashboard/machines" className="rounded-md border border-line px-3 py-1.5 text-mist transition-colors hover:text-chalk">
            Register a machine
          </Link>
          <Link href="/machines" className="rounded-md border border-line px-3 py-1.5 text-mist transition-colors hover:text-chalk">
            The roster
          </Link>
          <Link href="/fleet" className="rounded-md border border-line px-3 py-1.5 text-mist transition-colors hover:text-chalk">
            The fleet
          </Link>
          <Link href="/world" className="rounded-md border border-line px-3 py-1.5 text-mist transition-colors hover:text-chalk">
            The Harbour
          </Link>
        </div>
      </section>
    </main>
  );
}
