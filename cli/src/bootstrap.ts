// Pasang host Node SEBELUM modul core lain dievaluasi (import side-effect pertama).
import { setHost } from '@topupsaja/core/host.js'
import { nodeHost } from '@topupsaja/core/host-node.js'

setHost(nodeHost)
