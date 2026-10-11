# App Store Connect API coverage

Generated from Apple's official OpenAPI spec **v4.5.1** on 2026-10-11.

**1303 operations**: 826 reads (GET), 180 creates (POST), 162 edits (PATCH), 135 deletes (DELETE).

## Notable capabilities (present in Apple's spec?)

| Capability | In Apple's API |
|---|---|
| Create a brand-new app record | **no (console only)** |
| Upload a build (buildUploads) | yes |
| Submit a version for review (reviewSubmissions) | yes |
| Reply to customer reviews | yes |
| Upload screenshots | yes |
| Edit store-listing text (version localizations) | yes |
| Phased release control | yes |
| TestFlight groups and testers | yes |
| Subscriptions and in-app purchases | yes |
| App pricing | yes |
| Sales and finance reports | yes |
| Analytics reports | yes |
| App privacy / data-usage labels | **no (console only)** |
| Paid Apps agreement, tax and banking | **no (console only)** |
| Invite and manage users | yes |
| Xcode Cloud | yes |

"No" means the operation is not in Apple's published spec, so it cannot be done through any API client.

## Operations by area

| Area | GET | POST | PATCH | DELETE |
|---|---|---|---|---|
| AccessibilityDeclarations | 1 | 1 | 1 | 1 |
| Actors | 2 | 0 | 0 | 0 |
| AgeRatingDeclarations | 0 | 0 | 1 | 0 |
| AlternativeDistributionDomains | 2 | 1 | 0 | 1 |
| AlternativeDistributionKeys | 2 | 1 | 0 | 1 |
| AlternativeDistributionPackageDeltas | 1 | 0 | 0 | 0 |
| AlternativeDistributionPackages | 3 | 1 | 0 | 0 |
| AlternativeDistributionPackageVariants | 1 | 0 | 0 | 0 |
| AlternativeDistributionPackageVersions | 5 | 0 | 0 | 0 |
| AnalyticsReportInstances | 3 | 0 | 0 | 0 |
| AnalyticsReportRequests | 3 | 1 | 0 | 1 |
| AnalyticsReports | 3 | 0 | 0 | 0 |
| AnalyticsReportSegments | 1 | 0 | 0 | 0 |
| AndroidToIosAppMappingDetails | 1 | 1 | 1 | 1 |
| AppAssetLibraries | 5 | 0 | 0 | 0 |
| AppAssetLibraryImages | 3 | 1 | 1 | 1 |
| AppAssetLibraryPlacementOrderingRequests | 0 | 1 | 0 | 0 |
| AppAssetLibraryPlacements | 1 | 1 | 0 | 1 |
| AppAssetLibraryRefData | 2 | 0 | 0 | 0 |
| AppAssetLibraryVideos | 3 | 1 | 1 | 1 |
| AppAvailabilities | 3 | 1 | 0 | 0 |
| AppCategories | 6 | 0 | 0 | 0 |
| AppClipAdvancedExperienceImages | 1 | 1 | 1 | 0 |
| AppClipAdvancedExperiences | 1 | 1 | 1 | 0 |
| AppClipAppStoreReviewDetails | 1 | 1 | 1 | 0 |
| AppClipDefaultExperienceLocalizations | 3 | 1 | 1 | 1 |
| AppClipDefaultExperiences | 7 | 1 | 2 | 1 |
| AppClipHeaderImages | 1 | 1 | 1 | 1 |
| AppClips | 5 | 0 | 0 | 0 |
| AppCustomProductPageLocalizations | 9 | 2 | 1 | 2 |
| AppCustomProductPages | 3 | 1 | 1 | 1 |
| AppCustomProductPageVersions | 3 | 1 | 1 | 0 |
| AppEncryptionDeclarationDocuments | 1 | 1 | 1 | 0 |
| AppEncryptionDeclarations | 6 | 2 | 0 | 0 |
| AppEventLocalizations | 7 | 1 | 1 | 1 |
| AppEvents | 3 | 1 | 1 | 1 |
| AppEventScreenshots | 1 | 1 | 1 | 1 |
| AppEventVideoClips | 1 | 1 | 1 | 1 |
| AppInfoLocalizations | 1 | 1 | 1 | 1 |
| AppInfos | 19 | 0 | 1 | 0 |
| AppPreviews | 1 | 1 | 1 | 1 |
| AppPreviewSets | 3 | 1 | 1 | 1 |
| AppPricePoints | 3 | 0 | 0 | 0 |
| AppPriceSchedules | 7 | 1 | 0 | 0 |
| Apps | 86 | 0 | 2 | 1 |
| AppScreenshots | 1 | 1 | 1 | 1 |
| AppScreenshotSets | 3 | 1 | 1 | 1 |
| AppStoreReviewAttachments | 1 | 1 | 1 | 1 |
| AppStoreReviewDetails | 3 | 1 | 1 | 0 |
| AppStoreVersionExperiments | 6 | 2 | 2 | 2 |
| AppStoreVersionExperimentTreatmentLocalizations | 7 | 1 | 0 | 1 |
| AppStoreVersionExperimentTreatments | 3 | 1 | 1 | 1 |
| AppStoreVersionLocalizations | 9 | 2 | 1 | 2 |
| AppStoreVersionPhasedReleases | 0 | 1 | 1 | 1 |
| AppStoreVersionPromotions | 0 | 1 | 0 | 0 |
| AppStoreVersionReleaseRequests | 0 | 1 | 0 | 0 |
| AppStoreVersions | 25 | 1 | 3 | 1 |
| AppStoreVersionSubmissions | 0 | 0 | 0 | 1 |
| AppTags | 2 | 0 | 1 | 0 |
| BackgroundAssets | 3 | 1 | 1 | 0 |
| BackgroundAssetUploadFiles | 1 | 1 | 1 | 0 |
| BackgroundAssetVersionAppStoreReleases | 1 | 0 | 0 | 0 |
| BackgroundAssetVersionExternalBetaReleases | 1 | 0 | 0 | 0 |
| BackgroundAssetVersionInternalBetaReleases | 1 | 0 | 0 | 0 |
| BackgroundAssetVersions | 3 | 1 | 0 | 0 |
| BetaAppClipInvocationLocalizations | 0 | 1 | 1 | 1 |
| BetaAppClipInvocations | 1 | 1 | 1 | 1 |
| BetaAppLocalizations | 4 | 1 | 1 | 1 |
| BetaAppReviewDetails | 4 | 0 | 1 | 0 |
| BetaAppReviewSubmissions | 4 | 1 | 0 | 0 |
| BetaBuildLocalizations | 4 | 1 | 1 | 1 |
| BetaCrashLogs | 1 | 0 | 0 | 0 |
| BetaFeedbackCrashSubmissions | 3 | 0 | 0 | 1 |
| BetaFeedbackScreenshotSubmissions | 1 | 0 | 0 | 1 |
| BetaGroups | 14 | 3 | 1 | 3 |
| BetaLicenseAgreements | 4 | 0 | 1 | 0 |
| BetaRecruitmentCriteria | 0 | 1 | 1 | 1 |
| BetaRecruitmentCriterionOptions | 1 | 0 | 0 | 0 |
| BetaTesterInvitations | 0 | 1 | 0 | 0 |
| BetaTesters | 9 | 3 | 0 | 4 |
| BuildBetaDetails | 4 | 0 | 1 | 0 |
| BuildBetaNotifications | 0 | 1 | 0 | 0 |
| BuildBundles | 8 | 0 | 0 | 0 |
| Builds | 24 | 2 | 2 | 2 |
| BuildUploadFiles | 1 | 1 | 1 | 0 |
| BuildUploads | 3 | 1 | 0 | 1 |
| BundleIdCapabilities | 0 | 1 | 1 | 1 |
| BundleIds | 8 | 1 | 1 | 1 |
| Certificates | 4 | 1 | 1 | 1 |
| CiArtifacts | 1 | 0 | 0 | 0 |
| CiBuildActions | 9 | 0 | 0 | 0 |
| CiBuildRuns | 5 | 1 | 0 | 0 |
| CiIssues | 1 | 0 | 0 | 0 |
| CiMacOsVersions | 4 | 0 | 0 | 0 |
| CiProducts | 12 | 0 | 0 | 1 |
| CiTestResults | 1 | 0 | 0 | 0 |
| CiWorkflows | 5 | 1 | 1 | 1 |
| CiXcodeVersions | 4 | 0 | 0 | 0 |
| CustomerReviewResponses | 1 | 1 | 0 | 1 |
| CustomerReviews | 3 | 0 | 0 | 0 |
| Devices | 2 | 1 | 1 | 0 |
| DiagnosticSignatures | 1 | 0 | 0 | 0 |
| EndAppAvailabilityPreOrders | 0 | 1 | 0 | 0 |
| EndUserLicenseAgreements | 3 | 1 | 1 | 1 |
| FinanceReports | 1 | 0 | 0 | 0 |
| GameCenterAchievementImages | 2 | 2 | 2 | 2 |
| GameCenterAchievementLocalizations | 8 | 2 | 2 | 2 |
| GameCenterAchievementReleases | 1 | 1 | 0 | 1 |
| GameCenterAchievements | 10 | 2 | 5 | 2 |
| GameCenterAchievementVersions | 3 | 1 | 0 | 0 |
| GameCenterActivities | 3 | 5 | 1 | 5 |
| GameCenterActivityImages | 1 | 1 | 1 | 1 |
| GameCenterActivityLocalizations | 3 | 1 | 1 | 1 |
| GameCenterActivityVersionReleases | 1 | 1 | 0 | 1 |
| GameCenterActivityVersions | 5 | 1 | 1 | 0 |
| GameCenterAppVersions | 5 | 2 | 1 | 1 |
| GameCenterChallengeImages | 1 | 1 | 1 | 1 |
| GameCenterChallengeLocalizations | 3 | 1 | 1 | 1 |
| GameCenterChallenges | 3 | 1 | 3 | 1 |
| GameCenterChallengeVersionReleases | 1 | 1 | 0 | 1 |
| GameCenterChallengeVersions | 5 | 1 | 0 | 0 |
| GameCenterDetailPlayers | 0 | 0 | 1 | 0 |
| GameCenterDetails | 35 | 1 | 8 | 0 |
| GameCenterEnabledVersions | 2 | 1 | 1 | 1 |
| GameCenterGroups | 20 | 1 | 7 | 1 |
| GameCenterLeaderboardEntrySubmissions | 0 | 1 | 0 | 0 |
| GameCenterLeaderboardImages | 2 | 2 | 2 | 2 |
| GameCenterLeaderboardLocalizations | 6 | 2 | 2 | 2 |
| GameCenterLeaderboardReleases | 1 | 1 | 0 | 1 |
| GameCenterLeaderboards | 12 | 2 | 7 | 2 |
| GameCenterLeaderboardSetImages | 2 | 2 | 2 | 2 |
| GameCenterLeaderboardSetLocalizations | 6 | 2 | 2 | 2 |
| GameCenterLeaderboardSetMemberLocalizations | 5 | 1 | 1 | 1 |
| GameCenterLeaderboardSetReleases | 1 | 1 | 0 | 1 |
| GameCenterLeaderboardSets | 14 | 4 | 5 | 4 |
| GameCenterLeaderboardSetVersions | 3 | 1 | 0 | 0 |
| GameCenterLeaderboardVersions | 3 | 1 | 0 | 0 |
| GameCenterMatchmakingQueues | 7 | 1 | 1 | 1 |
| GameCenterMatchmakingRules | 3 | 1 | 1 | 1 |
| GameCenterMatchmakingRuleSets | 8 | 1 | 1 | 1 |
| GameCenterMatchmakingRuleSetTests | 0 | 1 | 0 | 0 |
| GameCenterMatchmakingTeams | 0 | 1 | 1 | 1 |
| GameCenterPlayerAchievementSubmissions | 0 | 1 | 0 | 0 |
| GameCenterScoreModerations | 0 | 0 | 1 | 0 |
| InAppPurchaseAppStoreReviewScreenshots | 1 | 1 | 1 | 1 |
| InAppPurchaseAvailabilities | 3 | 1 | 0 | 0 |
| InAppPurchaseContents | 1 | 0 | 0 | 0 |
| InAppPurchaseImages | 2 | 2 | 2 | 2 |
| InAppPurchaseLocalizations | 2 | 2 | 2 | 2 |
| InAppPurchaseOfferCodeCustomCodes | 1 | 1 | 1 | 0 |
| InAppPurchaseOfferCodeOneTimeUseCodes | 2 | 1 | 1 | 0 |
| InAppPurchaseOfferCodes | 7 | 1 | 1 | 0 |
| InAppPurchasePricePoints | 2 | 0 | 0 | 0 |
| InAppPurchasePriceSchedules | 7 | 1 | 0 | 0 |
| InAppPurchases | 22 | 1 | 1 | 1 |
| InAppPurchaseSubmissions | 0 | 1 | 0 | 0 |
| InAppPurchaseVersions | 7 | 1 | 0 | 0 |
| MarketplaceSearchDetails | 0 | 1 | 1 | 1 |
| MarketplaceWebhooks | 1 | 1 | 1 | 1 |
| MerchantIds | 4 | 1 | 1 | 1 |
| Nominations | 2 | 1 | 1 | 1 |
| PassTypeIds | 4 | 1 | 1 | 1 |
| PreReleaseVersions | 6 | 0 | 0 | 0 |
| Profiles | 8 | 1 | 0 | 1 |
| PromotedPurchases | 1 | 1 | 1 | 1 |
| ReviewSubmissionItems | 0 | 1 | 1 | 1 |
| ReviewSubmissions | 4 | 1 | 1 | 0 |
| RoutingAppCoverages | 1 | 1 | 1 | 1 |
| SalesReports | 1 | 0 | 0 | 0 |
| SandboxTesters | 1 | 0 | 1 | 0 |
| SandboxTestersClearPurchaseHistoryRequest | 0 | 1 | 0 | 0 |
| ScmGitReferences | 1 | 0 | 0 | 0 |
| ScmProviders | 4 | 0 | 0 | 0 |
| ScmPullRequests | 1 | 0 | 0 | 0 |
| ScmRepositories | 6 | 0 | 0 | 0 |
| SubscriptionAppStoreReviewScreenshots | 1 | 1 | 1 | 1 |
| SubscriptionAvailabilities | 3 | 1 | 0 | 0 |
| SubscriptionGracePeriods | 1 | 0 | 1 | 0 |
| SubscriptionGroupLocalizations | 2 | 2 | 2 | 2 |
| SubscriptionGroups | 7 | 1 | 1 | 1 |
| SubscriptionGroupSubmissions | 0 | 1 | 0 | 0 |
| SubscriptionGroupVersions | 3 | 1 | 0 | 0 |
| SubscriptionImages | 2 | 2 | 2 | 2 |
| SubscriptionIntroductoryOffers | 0 | 1 | 1 | 1 |
| SubscriptionLocalizations | 2 | 2 | 2 | 2 |
| SubscriptionOfferCodeCustomCodes | 1 | 1 | 1 | 0 |
| SubscriptionOfferCodeOneTimeUseCodes | 2 | 1 | 1 | 0 |
| SubscriptionOfferCodes | 7 | 1 | 1 | 0 |
| SubscriptionPlanAvailabilities | 3 | 1 | 2 | 0 |
| SubscriptionPricePoints | 4 | 0 | 0 | 0 |
| SubscriptionPrices | 0 | 1 | 0 | 1 |
| SubscriptionPromotionalOffers | 3 | 1 | 1 | 1 |
| Subscriptions | 27 | 1 | 1 | 3 |
| SubscriptionSubmissions | 0 | 1 | 0 | 0 |
| SubscriptionVersions | 7 | 1 | 0 | 0 |
| Territories | 1 | 0 | 0 | 0 |
| TerritoryAvailabilities | 0 | 0 | 1 | 0 |
| UserInvitations | 4 | 1 | 0 | 1 |
| Users | 4 | 1 | 2 | 2 |
| WebhookDeliveries | 0 | 1 | 0 | 0 |
| WebhookPings | 0 | 1 | 0 | 0 |
| Webhooks | 3 | 1 | 1 | 1 |
| WinBackOffers | 3 | 1 | 1 | 1 |
