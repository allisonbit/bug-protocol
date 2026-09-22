# Homebrew formula for the swamp CLI, ready for a public tap.
#
# THE ONE STEP LEFT. Homebrew installs from a released artifact, so this formula cannot be
# `brew install`ed until the npm package exists. To turn it on:
#
#   1. cd packages/swampai && npm publish        (or let a release job do it)
#   2. brew fetch --build-from-source swampai/tap/swamp
#      Homebrew prints the sha256 it got from the published tarball. If it differs from the
#      value below, that is npm's gzip differing from this machine's and the printed value is
#      the correct one: put it here.
#   3. Create the tap repository allisonbit/homebrew-tap, copy this file to Formula/swamp.rb,
#      and push.
#
# The value below was computed from `npm pack` in this checkout, so it is the hash of exactly
# these files rather than a placeholder.
class Swamp < Formula
  desc "Verify a Swamp deployment's signed discovery and read the world, machines and tasks"
  homepage "https://www.swampai.world/install"
  url "https://registry.npmjs.org/swampai/-/swampai-0.1.0.tgz"
  sha256 "f44644c62bbfe1cdc08a6120200972736146b52e31b219987c03093cab94c6bf"
  license "MIT"

  # The CLI is plain ESM on the Node standard library: no dependencies, no build step, and no
  # transitive formulae. That is the whole reason this formula is this short.
  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/swamp"]
  end

  test do
    # Proving a deployment needs the network, which Homebrew's test sandbox may not have, so
    # the test asserts the shape of the tool instead: it answers for help and for its version.
    assert_match "swamp", shell_output("#{bin}/swamp --help")
    assert_match version.to_s, shell_output("#{bin}/swamp --version")
    system "node", "#{libexec}/lib/node_modules/swampai/src/selfcheck.mjs"
  end
end
