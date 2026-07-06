import { ApiProperty } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { IsIn, IsString, Matches } from 'class-validator';

export class CreateUserRequestDto {
  @ApiProperty({ description: 'User display name' })
  @IsString()
  @Matches(/\S/, { message: 'name is required' })
  name!: string;

  @ApiProperty({ description: 'Unique login email' })
  @IsString()
  @Matches(/\S/, { message: 'email is required' })
  email!: string;

  @ApiProperty({ enum: [Role.ADMIN, Role.STAFF] })
  @IsIn([Role.ADMIN, Role.STAFF], {
    message: 'Only ADMIN and STAFF roles may be assigned',
  })
  role!: Extract<Role, 'ADMIN' | 'STAFF'>;

  @ApiProperty({
    description: 'Initial password issued by the facility admin',
    required: false,
  })
  initialPassword?: string;
}

export class UpdateUserRoleRequestDto {
  @ApiProperty({ enum: [Role.ADMIN, Role.STAFF] })
  @IsIn([Role.ADMIN, Role.STAFF], {
    message: 'Only ADMIN and STAFF roles may be assigned',
  })
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
