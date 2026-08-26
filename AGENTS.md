# Repository instructions

- Define functions before their first use. Keep helpers above the callers that
  invoke them so control flow reads top to bottom.
- Keep executable policy code in reviewed, dedicated TypeScript files. Policy
  JSON may reference a resolver file but must not contain executable source.
