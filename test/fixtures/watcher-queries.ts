// Copied from babysit-pr/scripts/gh_pr_watch.py on 2026-09-28.
// Source SHA-256: e2dae0d17f2528c27daf09d5ac6742e51eb9efaf9b837c36d21ff943f5c7cee2
// Keep the actual query text, including all comment and pagination fields.
export const watcherReviewThreadsQuery = `
query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          comments(first: 100) {
            pageInfo { hasNextPage endCursor }
            nodes {
  databaseId
  createdAt
  body
  path
  line
  originalLine
  url
  authorAssociation
  author { login __typename }
  pullRequestReview { state }
}
          }
        }
      }
    }
  }
}
`;
export const watcherThreadCommentsQuery = `
query($threadId: ID!, $cursor: String) {
  node(id: $threadId) {
    ... on PullRequestReviewThread {
      comments(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
  databaseId
  createdAt
  body
  path
  line
  originalLine
  url
  authorAssociation
  author { login __typename }
  pullRequestReview { state }
}
      }
    }
  }
}
`;
