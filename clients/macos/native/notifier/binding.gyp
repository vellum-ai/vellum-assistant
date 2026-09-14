{
  "targets": [
    {
      "target_name": "vellum_notifier",
      "sources": ["notifier.mm"],
      "include_dirs": ["<!(node -p \"require('node-addon-api').include_dir\")"],
      "conditions": [
        [
          "OS==\"mac\"",
          {
            "xcode_settings": {
              "CLANG_ENABLE_OBJC_ARC": "YES",
              "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
              "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
              "CLANG_CXX_LIBRARY": "libc++",
              "MACOSX_DEPLOYMENT_TARGET": "12.0"
            },
            "link_settings": {
              "libraries": [
                "$(SDKROOT)/System/Library/Frameworks/AppKit.framework",
                "$(SDKROOT)/System/Library/Frameworks/Foundation.framework",
                "$(SDKROOT)/System/Library/Frameworks/Intents.framework",
                "$(SDKROOT)/System/Library/Frameworks/UserNotifications.framework"
              ]
            }
          }
        ]
      ]
    }
  ]
}
