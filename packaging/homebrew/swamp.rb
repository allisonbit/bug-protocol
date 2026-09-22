# Homebrew formula for the swamp CLI.
#
# WHERE IT INSTALLS FROM, AND WHY NOT NPM'S REGISTRY. The published tarball lives on the GitHub
# release for this repository rather than on registry.npmjs.org, because a release asset needs
# no registry account to exist and the same bytes are then installable by npm, by Homebrew and
# by hand. The `url` and `sha256` below are the asset and the hash of the asset, and
# `scripts/verify-cli.cjs` downloads it and fails when they stop matching.
#
# THE TAP. This file is mirrored to Formula/swamp.rb in allisonbit/homebrew-tap, which is what
# `brew install allisonbit/tap/swamp` resolves. Release a new version by updating `url`,
# `sha256` and `version` here, running `node packages/swampai/build.mjs`, and pushing both
# copies.
class Swamp < Formula
  desc "Verify a Swamp deployment's signed discovery and read the world, machines and tasks"
  homepage "https://www.swampai.world/install"
  url "https://github.com/allisonbit/bug-protocol/releases/download/swampai-v0.1.0/swampai-0.1.0.tgz"
  sha256 "d8c7b62e9fcfbd7875f3c94c3e739997d5d8977e230bd463ba45aa82532831a5"
  license "MIT"
  version "0.1.0"

  # The CLI is plain ESM on the Node standard library: no dependencies, no build step, and no
  # transitive formulae. That is why this formula is this short.
  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/swamp"]
  end

  test do
    # Proving a deployment needs the network, which Homebrew's test sandbox may not have, so
    # this asserts the shape of the tool and then runs its own offline self-check, which is the
    # part that has to be right.
    assert_match "swamp", shell_output("#{bin}/swamp --help")
    assert_match version.to_s, shell_output("#{bin}/swamp --version")
    system "node", "#{libexec}/lib/node_modules/swampai/src/selfcheck.mjs"
  end
end
