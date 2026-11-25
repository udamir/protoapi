# Performance budgets on Node.js

Measured with `node bench/budgets.ts --write` on 2026-11-22: Node.js v26.13.0, darwin-x64, Intel(R) Core(TM) i9-9880H CPU @ 2.30GHz (16 threads), 5 rounds, each measurement in a fresh process (min of 3 runs after warm-up).

| Row           | Measures                                     |  Budget |     Min |  Median |     Max | Max / budget |
| ------------- | -------------------------------------------- | ------: | ------: | ------: | ------: | -----------: |
| PB-9.1        | buildFromProto, 140 KB                       |  150 ms |   72 ms |   75 ms |   81 ms |          54% |
| PB-9.2        | buildFromProto, 1.4 MB, with source map      | 1000 ms |  608 ms |  612 ms |  621 ms |          62% |
| PB-9.3        | buildFromProto, 8.6 MB                       | 7000 ms | 3856 ms | 3902 ms | 3943 ms |          56% |
| PB-9.3 ratio  | time per MB, 8.6 MB / 1.4 MB                 |   1.30x |   1.06x |   1.06x |   1.07x |          82% |
| PB-9.4        | buildFromDescriptorSet, 11 MB ProtoJSON      |  500 ms |  443 ms |  458 ms |  463 ms |          93% |
| PB-9.5        | printProto, 1.4 MB corpus                    |  500 ms |  201 ms |  202 ms |  208 ms |          42% |
| PB-9.6        | text-format parsing, 10,000 aggregate values |  100 ms |   33 ms |   34 ms |   40 ms |          40% |
| PARSE-1       | parseProto, 1.5 MB synthetic file            | 1000 ms |  172 ms |  173 ms |  180 ms |          18% |
| PARSE-1 index | line index + lookups                         |  200 ms |    2 ms |    2 ms |    2 ms |           1% |
