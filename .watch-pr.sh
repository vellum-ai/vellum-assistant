#!/bin/bash
# Watch PR 43172 for new bot/reviewer comments.
prev=$(gh pr view 43172 --json comments --jq '.comments | length')
prevr=$(gh api repos/vellum-ai/vellum-assistant/pulls/43172/comments --jq 'length')
for i in $(seq 1 50); do
  sleep 25
  n=$(gh pr view 43172 --json comments --jq '.comments | length')
  nr=$(gh api repos/vellum-ai/vellum-assistant/pulls/43172/comments --jq 'length')
  if [ "$n" != "$prev" ]; then
    echo "NEW ISSUE COMMENT count $prev -> $n"
    prev="$n"
  fi
  if [ "$nr" != "$prevr" ]; then
    echo "NEW INLINE REVIEW COMMENT count $prevr -> $nr"
    prevr="$nr"
  fi
done
