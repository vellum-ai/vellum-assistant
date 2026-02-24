/**
 * GraphQL queries for DoorDash store pages, item details, and retail store feeds.
 * Each query is fully self-contained with all required fragment definitions.
 */

// ---------------------------------------------------------------------------
// STORE_PAGE_QUERY
// ---------------------------------------------------------------------------

export const STORE_PAGE_QUERY = `
query storepageFeed($storeId: ID!, $menuId: ID, $isMerchantPreview: Boolean, $fulfillmentType: FulfillmentType, $cursor: String, $menuSurfaceArea: MenuSurfaceArea, $scheduledTime: String, $scheduledMinTimeUtc: String, $scheduledMaxTimeUtc: String, $entryPoint: StoreEntryPoint, $DMGroups: [DMGroup]) {
  storepageFeed(storeId: $storeId, menuId: $menuId, isMerchantPreview: $isMerchantPreview, fulfillmentType: $fulfillmentType, cursor: $cursor, menuSurfaceArea: $menuSurfaceArea, scheduledTime: $scheduledTime, scheduledMinTimeUtc: $scheduledMinTimeUtc, scheduledMaxTimeUtc: $scheduledMaxTimeUtc, entryPoint: $entryPoint, DMGroups: $DMGroups) {
    storeHeader {
      id name description offersDelivery offersPickup isDashpassPartner
      coverImgUrl currency
      address { lat lng city state street displayAddress __typename }
      business { id name __typename }
      ratings { numRatings numRatingsDisplayString averageRating isNewlyAdded __typename }
      deliveryFeeLayout { title subtitle isSurging displayDeliveryFee __typename }
      deliveryTimeLayout { title subtitle __typename }
      status {
        delivery { isAvailable minutes displayUnavailableStatus unavailableReason __typename }
        pickup { isAvailable minutes displayUnavailableStatus unavailableReason __typename }
        __typename
      }
      asapMinutes asapPickupMinutes priceRange priceRangeDisplayString
      __typename
    }
    menuBook {
      id name displayOpenHours
      menuCategories { id name numItems next { anchor cursor __typename } __typename }
      menuList { id name displayOpenHours __typename }
      __typename
    }
    itemLists {
      id name description
      items {
        id name description displayPrice displayStrikethroughPrice imageUrl
        dynamicLabelDisplayString calloutDisplayString ratingDisplayString
        storeId
        quickAddContext {
          isEligible
          price { currency decimalPlaces displayString sign symbol unitAmount __typename }
          nestedOptions specialInstructions defaultQuantity __typename
        }
        dietaryTagsList { type abbreviatedTagDisplayString fullTagDisplayString __typename }
        badges { title titleColor backgroundColor badge { ...BadgeFragment __typename } __typename }
        __typename
      }
      __typename
    }
    carousels {
      id type name description
      items {
        id name description displayPrice displayStrikethroughPrice imgUrl
        dynamicLabelDisplayString calloutDisplayString ratingDisplayString
        nextCursor orderItemId
        __typename
      }
      __typename
    }
    __typename
  }
}

fragment BadgeFragment on Badge {
  isDashpass type text backgroundColor styleType dlsTagSize dlsTextStyle
  dlsTagStyle dlsTagType placement leadingIcon leadingIconSize trailingIcon
  trailingIconSize endTime dlsTextColor
  brandedDecorator { prefixText postfixText postfixTextLeadingIcon __typename }
  trailingText { copy dlsTextStyle dlsTextColor __typename }
  onClick __typename
}`;

// ---------------------------------------------------------------------------
// ITEM_PAGE_QUERY
// ---------------------------------------------------------------------------

export const ITEM_PAGE_QUERY = `
query itemPage($storeId: ID!, $itemId: ID!, $consumerId: ID, $isMerchantPreview: Boolean, $isNested: Boolean!, $fulfillmentType: FulfillmentType, $cursorContext: ItemPageCursorContextInput, $scheduledMinTimeUtc: String, $scheduledMaxTimeUtc: String) {
  itemPage(storeId: $storeId, itemId: $itemId, consumerId: $consumerId, isMerchantPreview: $isMerchantPreview, fulfillmentType: $fulfillmentType, cursorContext: $cursorContext, scheduledMinTimeUtc: $scheduledMinTimeUtc, scheduledMaxTimeUtc: $scheduledMaxTimeUtc) {
    itemHeader @skip(if: $isNested) {
      id name imgUrl description displayString unitAmount currency decimalPlaces
      specialInstructionsMaxLength calloutDisplayString quantityLimit
      caloricInfoDisplayString menuId
      dietaryTagsList { type abbreviatedTagDisplayString fullTagDisplayString __typename }
      __typename
    }
    optionLists {
      type id name subtitle selectionNode minNumOptions maxNumOptions
      minAggregateOptionsQuantity maxAggregateOptionsQuantity
      minOptionChoiceQuantity maxOptionChoiceQuantity numFreeOptions isOptional
      options {
        id name unitAmount currency displayString decimalPlaces nextCursor
        caloricInfoDisplayString chargeAbove defaultQuantity imgUrl sortOrder
        minOptionChoiceQuantity maxOptionChoiceQuantity
        dietaryTagsList { type abbreviatedTagDisplayString fullTagDisplayString __typename }
        nestedExtrasList {
          type id name subtitle selectionNode minNumOptions maxNumOptions
          minOptionChoiceQuantity maxOptionChoiceQuantity numFreeOptions isOptional
          options {
            id name unitAmount currency displayString decimalPlaces nextCursor
            caloricInfoDisplayString imgUrl __typename
          }
          __typename
        }
        __typename
      }
      __typename
    }
    itemPreferences {
      id title
      specialInstructions { title characterMaxLength isEnabled placeholderText __typename }
      substitutionPreferences {
        title
        substitutionPreferencesList { id displayString isDefault value __typename }
        __typename
      }
      __typename
    }
    itemFooter { id data { title placementsFooter __typename } __typename }
    __typename
  }
}`;

// ---------------------------------------------------------------------------
// RETAIL_STORE_FEED_QUERY (for convenience/pharmacy stores like CVS, Duane Reade)
// ---------------------------------------------------------------------------

export const RETAIL_STORE_FEED_QUERY = `
query storeFeed($storeId: ID!, $attrSrc: String, $cursor: String, $enableDebug: Boolean) {
  retailStorePageFeed(
    storeId: $storeId
    attrSrc: $attrSrc
    cursor: $cursor
    enableDebug: $enableDebug
  ) {
    id
    storeDetails {
      id urlSlug name isActive coverSquareImgUrl
      storeHeader {
        ...StoreHeaderFragment
        __typename
      }
      __typename
    }
    l1Categories {
      ...RetailL1CategoryFragment
      __typename
    }
    l1NavCategories {
      ...RetailL1NavCategoryFragment
      __typename
    }
    collections {
      ...RetailCollectionFragment
      __typename
    }
    page {
      next { name data __typename }
      onLoad { name data __typename }
      __typename
    }
    __typename
  }
}

fragment StoreHeaderFragment on StoreHeader {
  id name description offersDelivery isConvenience isDashpassPartner
  coverImgUrl
  ratings { numRatings numRatingsDisplayString averageRating isNewlyAdded __typename }
  deliveryFeeLayout { title subtitle isSurging displayDeliveryFee __typename }
  distanceFromConsumer { value label __typename }
  priceRangeDisplayString priceRange
  address { displayAddress street city __typename }
  status {
    delivery { isAvailable minutes displayUnavailableStatus unavailableReason etaDisplayString __typename }
    __typename
  }
  __typename
}

fragment RetailL1CategoryFragment on RetailL1Category {
  id categoryId urlSlug name storeId imageUrl __typename
}

fragment RetailCollectionFragment on RetailCollection {
  id collectionId urlSlug name storeId
  products {
    ...BaseRetailItemDetailsFragment
    __typename
  }
  pageInfo { cursor hasNextPage __typename }
  __typename
}

fragment BaseRetailItemDetailsFragment on RetailItem {
  id urlSlug name description storeId menuId imageUrl
  price { ...MonetaryFieldsFragment __typename }
  quickAddContext {
    isEligible
    price { currency decimalPlaces displayString unitAmount __typename }
    nestedOptions specialInstructions defaultQuantity __typename
  }
  badges {
    text type placement __typename
  }
  __typename
}

fragment MonetaryFieldsFragment on AmountMonetaryFields {
  currency displayString decimalPlaces unitAmount sign symbol __typename
}

fragment RetailL1NavCategoryFragment on RetailL1NavCategory {
  id name urlSlug imageUrl storeId categoryId navigationType
  navigationData {
    collectionPageRequest {
      storeId collectionId collectionType showExploreItems attrSrc showCategories page supportsPagination __typename
    }
    collectionsRequest {
      surface orderCartId itemId attrSrc page storeId __typename
    }
    __typename
  }
  __typename
}`;

// ---------------------------------------------------------------------------
// RETAIL_SEARCH_QUERY (search within a convenience/pharmacy store)
// ---------------------------------------------------------------------------

export const RETAIL_SEARCH_QUERY = `
query convenienceSearchQuery($input: RetailSearchInput!) {
  retailSearch(input: $input) {
    query
    searchSummary {
      searchedForKeyword suggestedSearchKeyword totalCount __typename
    }
    legoRetailItems {
      id custom __typename
    }
    pageInfo { hasNextPage cursor __typename }
    __typename
  }
}`;
