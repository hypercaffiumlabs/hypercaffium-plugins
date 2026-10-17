# Google sign-in setup coverage

What this plugin handles, and how. Checked 2026-10-16.

Google offers **no public API** for the Google Auth Platform screens a standard app uses. The old IAP OAuth Admin APIs (`gcloud iap oauth-brands`, `gcloud iap oauth-clients`) were shut down on 2026-03-19, and `gcloud iam oauth-clients` is for Workforce Identity Federation only. Those steps therefore run in the browser through Kapture.

## Areas and how each is handled

| Area | Action | How | Approval |
|---|---|---|---|
| List projects | `google_list_projects` | gcloud | None (read) |
| Enabled APIs | `google_project_status` | gcloud | None (read) |
| Enable an API | `enable_api` | gcloud | Preview + yes |
| Branding (app name, support email, links, developer contact) | `set_branding` | Console, Kapture | Preview + yes |
| Scopes: add | `add_scopes` | Console, Kapture | Preview + yes |
| Scopes: remove | `remove_scopes` | Console, Kapture | Critical, sensitive tool |
| Test users | `add_test_user` | Console, Kapture | Preview + yes |
| Audience (External or Internal) | `set_user_type` | Console, Kapture | Preview + yes |
| Publish to production | `publish` | Console, Kapture | Preview + yes |
| Back to Testing | `back_to_testing` | Console, Kapture | Critical, sensitive tool |
| Create an OAuth client | `create_client` | Console, Kapture; the client file is installed from Downloads | Preview + yes (overwriting an existing client file: critical, sensitive tool) |
| Delete an OAuth client | `delete_client` | Console, Kapture | Critical, sensitive tool |
| Sign in an account | `sign_in_account` | The recipe's own login command | Preview + yes |
| Save your own recipe | `save_recipe` | Local file | Preview + yes |
| Read console state (status, scopes, clients, verification) | `google_console_page`, `google_evaluate_console` | Console, Kapture, read only | None (read) |
| Saved logins: valid, real scopes | `google_check_accounts` | Google's token endpoints | None (read) |
| Activity log | `google_audit_log` | Local file | None (read) |

## Not covered

| Area | Why |
|---|---|
| Google's app verification review | Done by Google; the plugin explains when it is needed and does not submit it |
| Service accounts, Workload and Workforce Identity, IAM roles | Out of scope |
| Google Workspace admin settings | Out of scope |
| Running the tools themselves | The plugin only sets up their Google side |
| Creating a new Google Cloud project | v1 lists existing projects only; create the project in the Google Cloud console first |
| Changing the downloads folder | The `downloadsDir` setting is not configurable in v1; client files are read from the Downloads folder only |
| Reading a client secret | Never. Google shows it once; the owner downloads the file and the plugin moves it unread |

## Console labels

The button and field labels used for console steps are partly unverified, and Google can rename them. The labels are verified by the self-test: `/hypercaffium-google-oauth:check --selftest <project>` opens every console page read-only and reports any expected label it could not find. Run it before a big setup, and after Google changes the console.

## Console pages

All on `console.cloud.google.com`, each with `?project=<id>`: `/auth/overview`, `/auth/branding`, `/auth/audience`, `/auth/clients`, `/auth/scopes`, `/auth/verification`.
