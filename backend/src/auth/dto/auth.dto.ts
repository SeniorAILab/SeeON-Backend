export interface LoginRequestDto {
  email?: unknown;
  password?: unknown;
}

export interface RegisterRequestDto {
  name?: unknown;
  email?: unknown;
  password?: unknown;
  phone?: unknown;
  facilityName?: unknown;
}

export interface CreateFacilityRequestDto {
  facilityName?: unknown;
}
