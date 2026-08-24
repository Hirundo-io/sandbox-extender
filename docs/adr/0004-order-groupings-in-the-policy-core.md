# Order groupings in the Policy Core

Profiles define ordered Groupings in application code, and the Policy Core evaluates them from first to last. A Grouping delegates an individual capability check to Cedar and yields a decisive result or abstains; the first decisive result wins, while later potential matches are logged as shadowed. This preserves explicit Profile order without inventing priority semantics inside Cedar.
