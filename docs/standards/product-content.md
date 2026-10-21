# Product content standard

Applies to public and private products: tools, skills, desktop apps and web services.
The owning project keeps the commands and product-specific details in its own documentation.

## Documentation

- Update README, usage docs and affected demos with the behaviour they describe.
- Public claims and install commands describe the delivered version or deployed revision.
  Check that revision when preparing website copy; a feature on `main` may not be delivered yet.
- State requirements, limitations, data handling and experimental status plainly. Link to the
  actual install, download or sign-in path. Advertise only features that work today.
- Release notes explain what changed for the user and identify affected claims, commands and
  images so other surfaces can be updated from the same facts.

## Demonstrations

- Capture the real UI or CLI using synthetic data. Do not fabricate output or use real personal
  data. A screenshot shows behaviour; it does not prove an unmeasured accuracy or performance claim.
- Document how to reproduce the demo: command, synthetic fixture, revision and relevant viewport,
  theme or locale. Keep product-specific renderers in the owning project.
- Review the generated image yourself. Check legibility, crop, labels and consistency with the
  current UI. Keep reusable source images in the project and optimise website copies separately.
- Website changes are checked in a browser at desktop and phone sizes, in supported themes.

## Ready for use

Verify the applicable delivery channels, a clean install or user flow, documentation and demos.
For a paid offer, also follow [paid product readiness](paid-readiness.md).
Keep the result tied to the delivered revision with evidence such as a release URL, deployment
URL or screenshot. Provide verified facts, source media and relevant public links to the
maintainer's separate publishing process. Account access, posting permissions, destinations,
queues and publication results belong outside product repositories.
