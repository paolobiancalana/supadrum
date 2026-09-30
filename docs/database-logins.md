# Personal database logins

One row per registered login (`database_logins` in the chamber
configuration, which is not versioned: add the row here and commit it when you
register the login there). A login belongs to exactly one person and one human
role, and its name ends with the person; a person who acts in both roles has
two logins. Never reuse a row for another person: register a new login, and
retire the old one by removing it from the configuration, dropping its role
through a broker SQL job and marking the row retired.

The password is not recorded anywhere but the Keychain entry named in the
configuration, and it is replaced on every `tests.run` that selects the login.
Each run's job result lists the logins it provisioned, with role and person.

| Login | Role | Person | Chamber | Registered by | Registered on | Status |
| --- | --- | --- | --- | --- | --- | --- |
