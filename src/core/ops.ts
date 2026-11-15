import type { Clock } from './hlc'
import type { EntityKind, Op } from './types'
import { uuid } from './util'

/** Creates ops stamped with the local HLC and device key. */
export class OpFactory {
  constructor(
    readonly groupId: string,
    private clock: Clock,
    readonly author: string,
  ) {}

  op(entity: EntityKind, entityId: string, set: Record<string, unknown>): Op {
    return { opId: uuid(), groupId: this.groupId, entity, entityId, set, hlc: this.clock.tick(), author: this.author }
  }
}
