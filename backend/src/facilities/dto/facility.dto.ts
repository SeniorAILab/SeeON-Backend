import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateFacilityRequestDto {
  @ApiPropertyOptional({ description: 'Facility display name' })
  name?: string;

  @ApiPropertyOptional({
    description: 'Facility street address; empty string clears the field',
    nullable: true,
  })
  address?: string | null;

  @ApiPropertyOptional({
    description: 'Facility contact phone; empty string clears the field',
    nullable: true,
  })
  phone?: string | null;
}
