# Repository instructions

- Define functions before their first use. Keep helpers above the callers that
  invoke them so control flow reads top to bottom.
- Keep executable policy code in reviewed, dedicated TypeScript files. Profile
  JSON may reference materializer files but must not contain executable source.
