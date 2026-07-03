import { ApiProperty } from '@nestjs/swagger';
import { Role } from '@prisma/client';

export class CreateUserRequestDto {
  @ApiProperty({ description: 'User display name' })
  name!: string;

  @ApiProperty({ description: 'Unique login email' })
  email!: string;

  @ApiProperty({ enum: [Role.ADMIN, Role.STAFF] })
  role!: Extract<Role, 'ADMIN' | 'STAFF'>;

  @ApiProperty({
    description: 'Initial password issued by the facility admin',
    required: false,
  })
  initialPassword?: string;
}

export class UpdateUserRoleRequestDto {
  @ApiProperty({ enum: [Role.ADMIN, Role.STAFF] })
  role!: Extract<Role, 'ADMIN' | 'STAFF'>;
}

export interface UserResponseDto {
  readonly id: string;
  readonly name: string;
  readonly email: string | null;
  readonly role: Role;
}

export interface CreateUserResponseDto {
  readonly user: UserResponseDto;
  readonly initialPassword: string;
}
