// PB-4: name resolution (design §5.3) against the buf oracle; cases in test/cases/resolution.ts.

import { cases } from "./cases/resolution"
import { describeCases } from "./cases/run"

describeCases("PB-4 name resolution", "resolution", cases)
