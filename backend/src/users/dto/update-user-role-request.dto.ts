import { ApiProperty } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { IsIn } from 'class-validator';

export class UpdateUserRoleRequestDto {
  @ApiProperty({ enum: [Role.ADMIN, Role.STAFF] })
  @IsIn([Role.ADMIN, Role.STAFF], {
    message: 'Only ADMIN and STAFF roles may be assigned',
  })
  role!: Extract<Role, 'ADMIN' | 'STAFF'>;
}
