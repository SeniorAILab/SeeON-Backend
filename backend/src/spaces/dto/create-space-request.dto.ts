import type { SpaceTypeValue } from '../space.types.js';

// Permissive by design: SpacesService enforces required-field/format rules
// via ConflictException (409); the global ValidationPipe must not preempt
// those with a 400, so these classes carry no class-validator decorators.
export class CreateSpaceRequestDto {
  floorId?: string;
  name?: string;
  type?: SpaceTypeValue;
  capacity?: number;
  isActive?: boolean;
  assignedStaff?: string | null;
  facilityId?: string;
}
