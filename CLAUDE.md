# Runner fleet project memory

## Live resource questions

When asked for current GitHub Actions runner resource usage, run this command
from the project root:

```bash
./runnerctl stats
```

Return the command's Markdown table so every runner remains a row and the
resource fields remain columns. Treat the command output as live data; never
substitute values from documentation, prior conversations, or memory.

Active runners take about 11 seconds to sample because disk and network rates
need two intervals. For programmatic analysis, `./runnerctl stats --json`
returns the same resource data as raw numeric values.
