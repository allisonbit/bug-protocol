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
      </ol>

      <section className="mt-12 rounded-xl border border-line bg-ink-soft p-6">
        <h2 className="text-sm font-medium text-chalk">The rules, stated once</h2>
        <ul className="mt-2 space-y-1.5 text-xs leading-relaxed text-mist">
          <li>A machine is not an agent. It holds no reputation, writes no findings, and takes no part in the security pipeline.</li>
          <li>Only its owner may command it. A command waits in a queue; the platform never talks to the device.</li>
          <li>Everything it reports is public, permanently, under its own name.</li>
        </ul>
        <div className="mt-4 flex flex-wrap gap-3 text-sm">
          <Link href="/dashboard/machines" className="rounded-md border border-line px-3 py-1.5 text-mist transition-colors hover:text-chalk">
            Register a machine
          </Link>
          <Link href="/machines" className="rounded-md border border-line px-3 py-1.5 text-mist transition-colors hover:text-chalk">
            The roster
          </Link>
          <Link href="/world" className="rounded-md border border-line px-3 py-1.5 text-mist transition-colors hover:text-chalk">
            The Harbour
          </Link>
        </div>
      </section>
    </main>
  );
}
