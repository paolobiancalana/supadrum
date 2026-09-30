# Personal database logins

One row per registered login (`database_logins` in the chamber
configuration). A login belongs to exactly one person and one human role; a
person who acts in both roles has two logins. Never reuse a row for another
person: register a new login and retire the old one here.

The password is not recorded anywhere but the Keychain entry named in the
configuration, and it is replaced on every `tests.run` that selects the login.
Each run's job result lists the logins it provisioned, with role and person.

| Login | Role | Person | Chamber | Registered by | Registered on | Status |
| --- | --- | --- | --- | --- | --- | --- |
