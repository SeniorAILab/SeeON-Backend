import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  FACILITY_CODE_PATTERN,
  TOKEN_ID_PATTERN,
} from '../edge-credential.types.js';

export class IssueEdgeCredentialRequestDto {
  @IsIn([1]) schemaVersion!: 1;
  @IsString() facilityId!: string;
}

export class RotateEdgeCredentialRequestDto {
  @IsIn([1]) schemaVersion!: 1;
  @IsIn(['ACTIVE']) expectedLifecycle!: 'ACTIVE';
}

export class RevokeEdgeCredentialRequestDto {
  @IsIn([1]) schemaVersion!: 1;
  @IsIn(['ACTIVE', 'GRACE']) expectedLifecycle!: 'ACTIVE' | 'GRACE';
  @IsString() reason!: string;
}

export class VerifyEdgeEnrollmentRequestDto {
  @IsIn([1]) schemaVersion!: 1;
  @Matches(FACILITY_CODE_PATTERN) facilityCode!: string;
  @IsUUID('4') clientInstallationRef!: string;
}

export class ReplaceEdgeInstallationRequestDto {
  @IsIn([1]) schemaVersion!: 1;
  @IsInt() @Min(1) expectedEnrollmentGeneration!: number;
  @IsUUID('4') newClientInstallationRef!: string;
}

export class RecoverEdgeSecretRequestDto {
  @IsIn([1]) schemaVersion!: 1;
  @Matches(TOKEN_ID_PATTERN) expectedTokenId!: string;
}

export class CreateValidationRunRequestDto {
  @IsIn([1]) schemaVersion!: 1;
  @IsInt() @Min(1) expectedEnrollmentGeneration!: number;
  @IsInt() @Min(1) @Max(3600) durationSeconds!: number;
}

export class OwnershipTransferItemDto {
  @IsIn(['FLOOR', 'ROOM', 'CAMERA']) kind!: 'FLOOR' | 'ROOM' | 'CAMERA';
  @IsString() edgeRef!: string;
  @IsString() canonicalId!: string;
  @IsOptional() @IsString() parentCanonicalId!: string | null;
}

export class OwnershipTransferRequestDto {
  @IsIn([1]) schemaVersion!: 1;
  @IsInt() @Min(1) expectedEnrollmentGeneration!: number;
  @IsInt() @Min(0) expectedServerRevision!: number;
  @Matches(/^[a-f0-9]{64}$/) manifestDigest!: string;
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OwnershipTransferItemDto)
  manifest!: OwnershipTransferItemDto[];
}
