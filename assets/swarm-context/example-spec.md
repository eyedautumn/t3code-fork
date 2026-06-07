# Example Specification

## Feature: User Authentication

### Requirements

1. Users can register with email/password
2. Users can login and logout
3. Sessions persist across browser refreshes

### Technical Details

- Use JWT tokens for authentication
- Store tokens in httpOnly cookies
- Session expiry: 7 days
