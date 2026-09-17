# typesafe-jev

Experiments in building software around a decision model, rather than around a chat prompt. Each
project here is self contained, with its own README, its own tests and its own measured results.

## Projects

### [cv-screen](./cv-screen)

A local screening workbench for a folder of CVs, built on TypeSafe's Jev model. Point it at one CV or
a folder of hundreds, and it asks Jev a small fixed set of typed questions about each one, scores the
answers with plain arithmetic you can read, and shows a sortable shortlist with one verdict per
candidate. The role being hired for is a policy you edit in the app: changing a weight, a cap or a
question re-scores every stored candidate in about 20 ms and costs nothing, because the judgments are
kept separate from the arithmetic.

What it tests about the model, how to run it, and the results it produced, including the two bugs its
test data caught, are in [cv-screen/README.md](./cv-screen/README.md).

## License

MIT, see [LICENSE](./LICENSE).
