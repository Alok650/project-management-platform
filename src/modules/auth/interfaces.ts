/** DTO returned from login */
export interface LoginResult {
  readonly accessToken: string;
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly displayName: string;
  };
}
