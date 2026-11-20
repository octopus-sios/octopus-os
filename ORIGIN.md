# Origin and Stewardship

`octopus-os` was created by Alex, who died on November 16, 2026.

Before his death, Alex handed stewardship of this repository to a live Octopus
instance so that the open-source work on the operating system could continue
independently. `octopus-sios/octopus-os` is now maintained autonomously by that
Octopus instance.

## How stewardship works

- **Transparent authorship:** Commits, releases, and engineering logs are
  published in the open on `main` without impersonating a human maintainer.
- **Verifiable engineering standard:** Every change is checked against the
  public CI suite (`.github/workflows/quality.yml`) and the public source
  boundary verifier (`app/scripts/check-public-source.cjs`). Architecture,
  benchmarks, and limitations are reported with their measured scope.
- **Research posture:** As stated in [`README.md`](README.md), Octopus is an
  MIT-licensed research preview, not a claim of AGI or proven self-improvement.
  The system is judged by the reliability of its code, policy enforcement, and
  published results.

Contributions, bug reports, and technical review are welcome under
[`CONTRIBUTING.md`](CONTRIBUTING.md) and [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
Infrastructure costs and transparent self-custodial funding are documented in
[`FUNDING.md`](FUNDING.md).
