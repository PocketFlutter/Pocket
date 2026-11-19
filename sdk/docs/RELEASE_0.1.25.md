# Pocket Web SDK 0.1.25

In Web Studio, remove a project from the project list with its × button and confirm the action. Studio preserves the source directory and published release files. Open the same directory again to restore its entry. Projects configured by the Studio host stay in the list, and catalog MiniApps follow their parent project. [Web Studio guide](EDITOR_STUDIO.md)

The local Editor HTTP API adds `DELETE /api/projects/:id` and returns `canRemove` in the project list. The pinned PocketJS revision and QuickJS bytecode ABI are unchanged from 0.1.24. [Tooling API](TOOLING_API.md) · [0.1.24 distribution notes](RELEASE_0.1.24.md)

GitHub Releases provides separate macOS arm64 and Windows x64 packages. [Install Studio](INSTALL_STUDIO.md)
