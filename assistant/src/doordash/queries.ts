/**
 * GraphQL query strings extracted from a recorded DoorDash session.
 * Each query is fully self-contained with all required fragment definitions.
 * No shared fragment variables are used — fragments are inlined per query.
 */

// ---------------------------------------------------------------------------
// SEARCH_QUERY
// ---------------------------------------------------------------------------

export const SEARCH_QUERY = `
query autocompleteFacetFeed($query: String!, $serializedBundleGlobalSearchContext: String) {
  autocompleteFacetFeed(
    query: $query
    serializedBundleGlobalSearchContext: $serializedBundleGlobalSearchContext
  ) {
    ...FacetFeedV2ResultFragment
    __typename
  }
}

fragment FacetFeedV2ResultFragment on FacetFeedV2Result {
  body {
    id
    header { ...FacetV2Fragment __typename }
    body { ...FacetV2Fragment __typename }
    layout { omitFooter __typename }
    __typename
  }
  page { ...FacetV2PageFragment __typename }
  header { ...FacetV2Fragment __typename }
  footer { ...FacetV2Fragment __typename }
  custom logging __typename
}

fragment FacetV2Fragment on FacetV2 {
  ...FacetV2BaseFragment
  childrenMap { ...FacetV2BaseFragment __typename }
  __typename
}

fragment FacetV2BaseFragment on FacetV2 {
  id childrenCount
  component { id category __typename }
  name
  text {
    title
    titleTextAttributes { textStyle textColor __typename }
    subtitle
    subtitleTextAttributes { textStyle textColor __typename }
    accessory
    accessoryTextAttributes { textStyle textColor __typename }
    description
    descriptionTextAttributes { textStyle textColor __typename }
    custom { key value __typename }
    __typename
  }
  images {
    main { ...FacetV2ImageFragment __typename }
    icon { ...FacetV2ImageFragment __typename }
    background { ...FacetV2ImageFragment __typename }
    accessory { ...FacetV2ImageFragment __typename }
    custom { key value { ...FacetV2ImageFragment __typename } __typename }
    __typename
  }
  events { click { name data __typename } __typename }
  style {
    spacing background_color
    border { color width style __typename }
    sizeClass dlsType __typename
  }
  layout {
    omitFooter
    gridSpecs {
      Mobile { ...FacetV2LayoutGridFragment __typename }
      Phablet { ...FacetV2LayoutGridFragment __typename }
      Tablet { ...FacetV2LayoutGridFragment __typename }
      Desktop { ...FacetV2LayoutGridFragment __typename }
      WideScreen { ...FacetV2LayoutGridFragment __typename }
      UltraWideScreen { ...FacetV2LayoutGridFragment __typename }
      __typename
    }
    dlsPadding { top right bottom left __typename }
    __typename
  }
  custom logging __typename
}

fragment FacetV2ImageFragment on FacetV2Image {
  uri videoUri placeholder local style logging
  events { click { name data __typename } __typename }
  __typename
}

fragment FacetV2LayoutGridFragment on FacetV2LayoutGrid {
  interRowSpacing interColumnSpacing minDimensionCount __typename
}

fragment FacetV2PageFragment on FacetV2Page {
  next { name data __typename }
  onLoad { name data __typename }
  __typename
}`;

// ---------------------------------------------------------------------------
// HOME_PAGE_QUERY
// ---------------------------------------------------------------------------

export const HOME_PAGE_QUERY = `
query homePageFacetFeed($cursor: String, $filterQuery: String, $displayHeader: Boolean, $isDebug: Boolean, $cuisineFilterVerticalIds: String) {
  homePageFacetFeed(
    cursor: $cursor
    filterQuery: $filterQuery
    displayHeader: $displayHeader
    isDebug: $isDebug
    cuisineFilterVerticalIds: $cuisineFilterVerticalIds
  ) {
    ...FacetFeedV2ResultFragment
    __typename
  }
}

fragment FacetFeedV2ResultFragment on FacetFeedV2Result {
  body {
    id
    header { ...FacetV2Fragment __typename }
    body { ...FacetV2Fragment __typename }
    layout { omitFooter __typename }
    __typename
  }
  page { ...FacetV2PageFragment __typename }
  header { ...FacetV2Fragment __typename }
  footer { ...FacetV2Fragment __typename }
  custom logging __typename
}

fragment FacetV2Fragment on FacetV2 {
  ...FacetV2BaseFragment
  childrenMap { ...FacetV2BaseFragment __typename }
  __typename
}

fragment FacetV2BaseFragment on FacetV2 {
  id childrenCount
  component { id category __typename }
  name
  text {
    title
    titleTextAttributes { textStyle textColor __typename }
    subtitle
    subtitleTextAttributes { textStyle textColor __typename }
    accessory
    accessoryTextAttributes { textStyle textColor __typename }
    description
    descriptionTextAttributes { textStyle textColor __typename }
    custom { key value __typename }
    __typename
  }
  images {
    main { ...FacetV2ImageFragment __typename }
    icon { ...FacetV2ImageFragment __typename }
    background { ...FacetV2ImageFragment __typename }
    accessory { ...FacetV2ImageFragment __typename }
    custom { key value { ...FacetV2ImageFragment __typename } __typename }
    __typename
  }
  events { click { name data __typename } __typename }
  style {
    spacing background_color
    border { color width style __typename }
    sizeClass dlsType __typename
  }
  layout {
    omitFooter
    gridSpecs {
      Mobile { ...FacetV2LayoutGridFragment __typename }
      Phablet { ...FacetV2LayoutGridFragment __typename }
      Tablet { ...FacetV2LayoutGridFragment __typename }
      Desktop { ...FacetV2LayoutGridFragment __typename }
      WideScreen { ...FacetV2LayoutGridFragment __typename }
      UltraWideScreen { ...FacetV2LayoutGridFragment __typename }
      __typename
    }
    dlsPadding { top right bottom left __typename }
    __typename
  }
  custom logging __typename
}

fragment FacetV2ImageFragment on FacetV2Image {
  uri videoUri placeholder local style logging
  events { click { name data __typename } __typename }
  __typename
}

fragment FacetV2LayoutGridFragment on FacetV2LayoutGrid {
  interRowSpacing interColumnSpacing minDimensionCount __typename
}

fragment FacetV2PageFragment on FacetV2Page {
  next { name data __typename }
  onLoad { name data __typename }
  __typename
}`;

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
// ADD_CART_ITEM_QUERY
// ---------------------------------------------------------------------------

export const ADD_CART_ITEM_QUERY = `
mutation addCartItem($addCartItemInput: AddCartItemInput!, $fulfillmentContext: FulfillmentContextInput!, $cartContext: CartContextInput, $returnCartFromOrderService: Boolean, $monitoringContext: MonitoringContextInput, $lowPriorityBatchAddCartItemInput: [AddCartItemInput!], $shouldKeepOnlyOneActiveCart: Boolean, $selectedDeliveryOption: SelectedDeliveryOptionInput) {
  addCartItemV2(
    addCartItemInput: $addCartItemInput
    fulfillmentContext: $fulfillmentContext
    cartContext: $cartContext
    returnCartFromOrderService: $returnCartFromOrderService
    monitoringContext: $monitoringContext
    lowPriorityBatchAddCartItemInput: $lowPriorityBatchAddCartItemInput
    shouldKeepOnlyOneActiveCart: $shouldKeepOnlyOneActiveCart
    selectedDeliveryOption: $selectedDeliveryOption
  ) {
    ...ConsumerOrderCartFragment
    __typename
  }
}

fragment ConsumerOrderCartFragment on OrderCart {
  id hasError cartType isConsumerPickup isConvenienceCart isPrescriptionDelivery
  prescriptionStoreInfo { retailStoreId __typename }
  isMerchantShipping offersDelivery offersPickup subtotal urlCode
  groupCart groupCartType groupCartSource groupCartPollInterval
  scheduledDeliveryAvailable isCatering isSameStoreCatering isBundle bundleType
  fulfillmentType originalBundleOrderCartId cartStatusType
  cateringInfo { cateringVersion minOrderSize maxOrderSize orderInAdvanceInSeconds cancelOrderInAdvanceInSeconds __typename }
  shortenedUrl maxIndividualCost serviceRateMessage isOutsideDeliveryRegion
  currencyCode asapMinutesRange
  orderTimeAvailability { ...CheckoutOrderTimeAvailabilityFragment __typename }
  menu { id hoursToOrderInAdvance name minOrderSize isCatering __typename }
  creator {
    id firstName lastName
    localizedNames { informalName formalName formalNameAbbreviated __typename }
    __typename
  }
  deliveries { id quotedDeliveryTime __typename }
  submittedAt
  restaurant {
    id name maxOrderSize coverImgUrl slug
    address { printableAddress street lat lng __typename }
    business { id name __typename }
    orderProtocol idealGroupSize highQualitySubtotalThreshold __typename
  }
  storeDisclaimers { id disclaimerDetailsLink disclaimerLinkSubstring disclaimerText displayTreatment __typename }
  orders { ...ConsumerOrdersFragment __typename }
  selectedDeliveryOption {
    deliveryOptionType
    scheduledWindow { rangeMinUtc rangeMaxUtc __typename }
    __typename
  }
  teamAccount { id name __typename }
  total totalBeforeDiscountsAndCredits
  footerDetails { title subtitle __typename }
  outOfStockMenuItemIds
  orderQualityInfo { isLoqNudgeAllowed isLoqForceSchedule __typename }
  ...InvalidItemsFragment
  ...ConsumerOrderCartDomainFragment
  __typename
}

fragment ConsumerOrdersFragment on Order {
  id
  consumer {
    firstName lastName id
    localizedNames { informalName formalName formalNameAbbreviated __typename }
    __typename
  }
  isSubCartFinalized splitBillSubcartStatus
  lineItems { ...LineItemFragment __typename }
  orderItems {
    __typename id
    options { id name quantity nestedOptions __typename }
    itemLevelDiscount { promoId promoCode externalCampaignId __typename }
    cartItemStatusType nestedOptions specialInstructions substitutionPreference
    quantity singlePrice priceOfTotalQuantity priceDisplayString
    nonDiscountPriceDisplayString continuousQuantity unit purchaseType
    estimatedPricingDescription isPrescriptionItem
    increment { decimalPlaces unitAmount __typename }
    discounts { ...OrderItemDiscountFragment __typename }
    item {
      id imageUrl name price minAgeRequirement
      category { title __typename }
      extras { id title description __typename }
      itemTagsList { tagType localizedName shortName id description displayType __typename }
      storeId __typename
    }
    bundleStore { ...OrderItemBundleFragment __typename }
    giftInfo { ...CartItemGiftInfoFragment __typename }
    badges { ...BadgeFragment __typename }
    nudgeList { ...NudgeFragment __typename }
    promoNudgeList { ...PromoNudgeFragment __typename }
    itemLimitData { ...ItemLimitDataFragment __typename }
  }
  paymentCard { id stripeId __typename }
  paymentLineItems { subtotal taxAmount subtotalTaxAmount feesTaxAmount serviceFee __typename }
  __typename
}

fragment LineItemFragment on LineItem {
  label labelIcon discountIcon chargeId
  finalMoney { unitAmount displayString __typename }
  originalMoney { unitAmount displayString __typename }
  tooltip { title paragraphs { description __typename } __typename }
  note __typename
}

fragment OrderItemDiscountFragment on OrderItemDiscount {
  id
  finalMoney { ...DiscountMonetaryFieldsFragment __typename }
  badges { ...BadgeFragment __typename }
  adsMetadata { ...DiscountAdsMetadataFragment __typename }
  __typename
}

fragment DiscountMonetaryFieldsFragment on AmountMonetaryFields {
  currency displayString decimalPlaces unitAmount sign __typename
}

fragment DiscountAdsMetadataFragment on AdsMetadata {
  campaignId adGroupId auctionId __typename
}

fragment OrderItemBundleFragment on OrderItemBundleStore {
  id name businessId isPrimary isRetail __typename
}

fragment CartItemGiftInfoFragment on CartItemGiftInfo {
  recipientName recipientPhone recipientEmail cardMessage senderName
  imageId imageUrl deliveryChannel __typename
}

fragment BadgeFragment on Badge {
  isDashpass type text backgroundColor styleType dlsTagSize dlsTextStyle
  dlsTagStyle dlsTagType placement leadingIcon leadingIconSize trailingIcon
  trailingIconSize endTime dlsTextColor
  brandedDecorator { prefixText postfixText postfixTextLeadingIcon __typename }
  trailingText { copy dlsTextStyle dlsTextColor __typename }
  onClick __typename
}

fragment NudgeFragment on Nudge {
  nudgeMessage { text icon color textStyle __typename }
  progress collectionModalDeeplink __typename
}

fragment PromoNudgeFragment on PromoNudge {
  ... on AddItemNudge {
    nudgeMessage { text icon color __typename }
    collectionModalDeeplink progress __typename
  }
  ... on ClipCouponNudge {
    nudgeMessage { text icon color __typename }
    buttonText incentiveId __typename
  }
  __typename
}

fragment ItemLimitDataFragment on ItemLimitData { limit __typename }

fragment InvalidItemsFragment on OrderCart {
  invalidItems {
    itemId storeId
    itemQuantityInfo {
      discreteQuantity { quantity unit __typename }
      continuousQuantity { quantity unit __typename }
      __typename
    }
    name itemExtrasList menuId __typename
  }
  __typename
}

fragment CheckoutOrderTimeAvailabilityFragment on OrderTimeAvailability {
  scheduleLongerInAdvanceTime timezone
  days {
    year month date
    times { display timestamp min max displayString displayStringDeliveryWindow displayStringSubtitle __typename }
    title subtitle isSelected isDisabled __typename
  }
  __typename
}

fragment ConsumerOrderCartDomainFragment on OrderCart {
  domain {
    giftInfo {
      recipientName recipientGivenName recipientFamilyName recipientPhone
      recipientEmail cardMessage cardId
      shouldNotifyTrackingToRecipientOnDasherAssign
      shouldNotifyRecipientForDasherQuestions senderName
      shouldRecipientScheduleGift hasGiftIntent __typename
    }
    __typename
  }
  __typename
}`;

// ---------------------------------------------------------------------------
// REMOVE_CART_ITEM_QUERY
// ---------------------------------------------------------------------------

export const REMOVE_CART_ITEM_QUERY = `
mutation removeCartItem($cartId: ID!, $itemId: ID!, $returnCartFromOrderService: Boolean, $monitoringContext: MonitoringContextInput, $cartContext: CartContextInput, $cartFilter: CartFilter) {
  removeCartItemV2(
    cartId: $cartId
    itemId: $itemId
    returnCartFromOrderService: $returnCartFromOrderService
    monitoringContext: $monitoringContext
    cartContext: $cartContext
    cartFilter: $cartFilter
  ) {
    ...ConsumerOrderCartFragment
    __typename
  }
}

fragment ConsumerOrderCartFragment on OrderCart {
  id hasError cartType isConsumerPickup isConvenienceCart isPrescriptionDelivery
  prescriptionStoreInfo { retailStoreId __typename }
  isMerchantShipping offersDelivery offersPickup subtotal urlCode
  groupCart groupCartType groupCartSource groupCartPollInterval
  scheduledDeliveryAvailable isCatering isSameStoreCatering isBundle bundleType
  fulfillmentType originalBundleOrderCartId cartStatusType
  cateringInfo { cateringVersion minOrderSize maxOrderSize orderInAdvanceInSeconds cancelOrderInAdvanceInSeconds __typename }
  shortenedUrl maxIndividualCost serviceRateMessage isOutsideDeliveryRegion
  currencyCode asapMinutesRange
  orderTimeAvailability { ...CheckoutOrderTimeAvailabilityFragment __typename }
  menu { id hoursToOrderInAdvance name minOrderSize isCatering __typename }
  creator {
    id firstName lastName
    localizedNames { informalName formalName formalNameAbbreviated __typename }
    __typename
  }
  deliveries { id quotedDeliveryTime __typename }
  submittedAt
  restaurant {
    id name maxOrderSize coverImgUrl slug
    address { printableAddress street lat lng __typename }
    business { id name __typename }
    orderProtocol idealGroupSize highQualitySubtotalThreshold __typename
  }
  storeDisclaimers { id disclaimerDetailsLink disclaimerLinkSubstring disclaimerText displayTreatment __typename }
  orders { ...ConsumerOrdersFragment __typename }
  selectedDeliveryOption {
    deliveryOptionType
    scheduledWindow { rangeMinUtc rangeMaxUtc __typename }
    __typename
  }
  teamAccount { id name __typename }
  total totalBeforeDiscountsAndCredits
  footerDetails { title subtitle __typename }
  outOfStockMenuItemIds
  orderQualityInfo { isLoqNudgeAllowed isLoqForceSchedule __typename }
  ...InvalidItemsFragment
  ...ConsumerOrderCartDomainFragment
  __typename
}

fragment ConsumerOrdersFragment on Order {
  id
  consumer {
    firstName lastName id
    localizedNames { informalName formalName formalNameAbbreviated __typename }
    __typename
  }
  isSubCartFinalized splitBillSubcartStatus
  lineItems { ...LineItemFragment __typename }
  orderItems {
    __typename id
    options { id name quantity nestedOptions __typename }
    itemLevelDiscount { promoId promoCode externalCampaignId __typename }
    cartItemStatusType nestedOptions specialInstructions substitutionPreference
    quantity singlePrice priceOfTotalQuantity priceDisplayString
    nonDiscountPriceDisplayString continuousQuantity unit purchaseType
    estimatedPricingDescription isPrescriptionItem
    increment { decimalPlaces unitAmount __typename }
    discounts { ...OrderItemDiscountFragment __typename }
    item {
      id imageUrl name price minAgeRequirement
      category { title __typename }
      extras { id title description __typename }
      itemTagsList { tagType localizedName shortName id description displayType __typename }
      storeId __typename
    }
    bundleStore { ...OrderItemBundleFragment __typename }
    giftInfo { ...CartItemGiftInfoFragment __typename }
    badges { ...BadgeFragment __typename }
    nudgeList { ...NudgeFragment __typename }
    promoNudgeList { ...PromoNudgeFragment __typename }
    itemLimitData { ...ItemLimitDataFragment __typename }
  }
  paymentCard { id stripeId __typename }
  paymentLineItems { subtotal taxAmount subtotalTaxAmount feesTaxAmount serviceFee __typename }
  __typename
}

fragment LineItemFragment on LineItem {
  label labelIcon discountIcon chargeId
  finalMoney { unitAmount displayString __typename }
  originalMoney { unitAmount displayString __typename }
  tooltip { title paragraphs { description __typename } __typename }
  note __typename
}

fragment OrderItemDiscountFragment on OrderItemDiscount {
  id
  finalMoney { ...DiscountMonetaryFieldsFragment __typename }
  badges { ...BadgeFragment __typename }
  adsMetadata { ...DiscountAdsMetadataFragment __typename }
  __typename
}

fragment DiscountMonetaryFieldsFragment on AmountMonetaryFields {
  currency displayString decimalPlaces unitAmount sign __typename
}

fragment DiscountAdsMetadataFragment on AdsMetadata {
  campaignId adGroupId auctionId __typename
}

fragment OrderItemBundleFragment on OrderItemBundleStore {
  id name businessId isPrimary isRetail __typename
}

fragment CartItemGiftInfoFragment on CartItemGiftInfo {
  recipientName recipientPhone recipientEmail cardMessage senderName
  imageId imageUrl deliveryChannel __typename
}

fragment BadgeFragment on Badge {
  isDashpass type text backgroundColor styleType dlsTagSize dlsTextStyle
  dlsTagStyle dlsTagType placement leadingIcon leadingIconSize trailingIcon
  trailingIconSize endTime dlsTextColor
  brandedDecorator { prefixText postfixText postfixTextLeadingIcon __typename }
  trailingText { copy dlsTextStyle dlsTextColor __typename }
  onClick __typename
}

fragment NudgeFragment on Nudge {
  nudgeMessage { text icon color textStyle __typename }
  progress collectionModalDeeplink __typename
}

fragment PromoNudgeFragment on PromoNudge {
  ... on AddItemNudge {
    nudgeMessage { text icon color __typename }
    collectionModalDeeplink progress __typename
  }
  ... on ClipCouponNudge {
    nudgeMessage { text icon color __typename }
    buttonText incentiveId __typename
  }
  __typename
}

fragment ItemLimitDataFragment on ItemLimitData { limit __typename }

fragment InvalidItemsFragment on OrderCart {
  invalidItems {
    itemId storeId
    itemQuantityInfo {
      discreteQuantity { quantity unit __typename }
      continuousQuantity { quantity unit __typename }
      __typename
    }
    name itemExtrasList menuId __typename
  }
  __typename
}

fragment CheckoutOrderTimeAvailabilityFragment on OrderTimeAvailability {
  scheduleLongerInAdvanceTime timezone
  days {
    year month date
    times { display timestamp min max displayString displayStringDeliveryWindow displayStringSubtitle __typename }
    title subtitle isSelected isDisabled __typename
  }
  __typename
}

fragment ConsumerOrderCartDomainFragment on OrderCart {
  domain {
    giftInfo {
      recipientName recipientGivenName recipientFamilyName recipientPhone
      recipientEmail cardMessage cardId
      shouldNotifyTrackingToRecipientOnDasherAssign
      shouldNotifyRecipientForDasherQuestions senderName
      shouldRecipientScheduleGift hasGiftIntent __typename
    }
    __typename
  }
  __typename
}`;

// ---------------------------------------------------------------------------
// DETAILED_CART_QUERY
// ---------------------------------------------------------------------------

export const DETAILED_CART_QUERY = `
query detailedCartItems($orderCartId: ID!, $corporateIndividualOrdersEnabled: Boolean, $deliveryOptionType: DeliveryOptionType, $isCardPayment: Boolean) {
  orderCart(id: $orderCartId, corporateIndividualOrdersEnabled: $corporateIndividualOrdersEnabled, deliveryOptionType: $deliveryOptionType, isCardPayment: $isCardPayment) {
    id subtotal total totalBeforeDiscountsAndCredits isSameStoreCatering isConvenienceCart
    outOfStockMenuItemIds
    ...InvalidItemsFragment
    orders {
      id
      consumer {
        id firstName lastName
        localizedNames { informalName formalName formalNameAbbreviated __typename }
        __typename
      }
      isSubCartFinalized splitBillSubcartStatus
      lineItems { ...LineItemFragment __typename }
      paymentCard { id stripeId __typename }
      paymentLineItems { subtotal taxAmount subtotalTaxAmount feesTaxAmount serviceFee __typename }
      orderItems {
        __typename id cartItemStatusType
        options { id name quantity price nestedOptions __typename }
        nestedOptions specialInstructions substitutionPreference
        quantity singlePrice priceOfTotalQuantity priceDisplayString
        nonDiscountPriceDisplayString continuousQuantity unit purchaseType
        estimatedPricingDescription isPrescriptionItem
        increment { decimalPlaces unitAmount __typename }
        itemLevelDiscount { promoId promoCode externalCampaignId __typename }
        discounts { ...OrderItemDiscountFragment __typename }
        item {
          id imageUrl name price minAgeRequirement
          category { title __typename }
          extras { id title description __typename }
          itemTagsList { tagType localizedName shortName id description displayType __typename }
          storeId __typename
        }
        bundleStore { ...OrderItemBundleFragment __typename }
        giftInfo { ...CartItemGiftInfoFragment __typename }
        badges { ...BadgeFragment __typename }
        nudgeList { ...NudgeFragment __typename }
        promoNudgeList { ...PromoNudgeFragment __typename }
        itemLimitData { ...ItemLimitDataFragment __typename }
      }
      __typename
    }
    footerDetails { title subtitle __typename }
    __typename
  }
}

fragment InvalidItemsFragment on OrderCart {
  invalidItems {
    itemId storeId
    itemQuantityInfo {
      discreteQuantity { quantity unit __typename }
      continuousQuantity { quantity unit __typename }
      __typename
    }
    name itemExtrasList menuId __typename
  }
  __typename
}

fragment LineItemFragment on LineItem {
  label labelIcon discountIcon chargeId
  finalMoney { unitAmount displayString __typename }
  originalMoney { unitAmount displayString __typename }
  tooltip { title paragraphs { description __typename } __typename }
  note __typename
}

fragment OrderItemDiscountFragment on OrderItemDiscount {
  id
  finalMoney { ...DiscountMonetaryFieldsFragment __typename }
  badges { ...BadgeFragment __typename }
  adsMetadata { ...DiscountAdsMetadataFragment __typename }
  __typename
}

fragment DiscountMonetaryFieldsFragment on AmountMonetaryFields {
  currency displayString decimalPlaces unitAmount sign __typename
}

fragment DiscountAdsMetadataFragment on AdsMetadata {
  campaignId adGroupId auctionId __typename
}

fragment OrderItemBundleFragment on OrderItemBundleStore {
  id name businessId isPrimary isRetail __typename
}

fragment CartItemGiftInfoFragment on CartItemGiftInfo {
  recipientName recipientPhone recipientEmail cardMessage senderName
  imageId imageUrl deliveryChannel __typename
}

fragment BadgeFragment on Badge {
  isDashpass type text backgroundColor styleType dlsTagSize dlsTextStyle
  dlsTagStyle dlsTagType placement leadingIcon leadingIconSize trailingIcon
  trailingIconSize endTime dlsTextColor
  brandedDecorator { prefixText postfixText postfixTextLeadingIcon __typename }
  trailingText { copy dlsTextStyle dlsTextColor __typename }
  onClick __typename
}

fragment NudgeFragment on Nudge {
  nudgeMessage { text icon color textStyle __typename }
  progress collectionModalDeeplink __typename
}

fragment PromoNudgeFragment on PromoNudge {
  ... on AddItemNudge {
    nudgeMessage { text icon color __typename }
    collectionModalDeeplink progress __typename
  }
  ... on ClipCouponNudge {
    nudgeMessage { text icon color __typename }
    buttonText incentiveId __typename
  }
  __typename
}

fragment ItemLimitDataFragment on ItemLimitData { limit __typename }`;

// ---------------------------------------------------------------------------
// LIST_CARTS_QUERY
// ---------------------------------------------------------------------------

export const LIST_CARTS_QUERY = `
query listCarts($input: ListCartsInput!) {
  listCarts(input: $input) {
    ...ConsumerOrderCartFragment
    __typename
  }
}

fragment ConsumerOrderCartFragment on OrderCart {
  id hasError cartType isConsumerPickup isConvenienceCart isPrescriptionDelivery
  prescriptionStoreInfo { retailStoreId __typename }
  isMerchantShipping offersDelivery offersPickup subtotal urlCode
  groupCart groupCartType groupCartSource groupCartPollInterval
  scheduledDeliveryAvailable isCatering isSameStoreCatering isBundle bundleType
  fulfillmentType originalBundleOrderCartId cartStatusType
  cateringInfo { cateringVersion minOrderSize maxOrderSize orderInAdvanceInSeconds cancelOrderInAdvanceInSeconds __typename }
  shortenedUrl maxIndividualCost serviceRateMessage isOutsideDeliveryRegion
  currencyCode asapMinutesRange
  orderTimeAvailability { ...CheckoutOrderTimeAvailabilityFragment __typename }
  menu { id hoursToOrderInAdvance name minOrderSize isCatering __typename }
  creator {
    id firstName lastName
    localizedNames { informalName formalName formalNameAbbreviated __typename }
    __typename
  }
  deliveries { id quotedDeliveryTime __typename }
  submittedAt
  restaurant {
    id name maxOrderSize coverImgUrl slug
    address { printableAddress street lat lng __typename }
    business { id name __typename }
    orderProtocol idealGroupSize highQualitySubtotalThreshold __typename
  }
  storeDisclaimers { id disclaimerDetailsLink disclaimerLinkSubstring disclaimerText displayTreatment __typename }
  orders { ...ConsumerOrdersFragment __typename }
  selectedDeliveryOption {
    deliveryOptionType
    scheduledWindow { rangeMinUtc rangeMaxUtc __typename }
    __typename
  }
  teamAccount { id name __typename }
  total totalBeforeDiscountsAndCredits
  footerDetails { title subtitle __typename }
  outOfStockMenuItemIds
  orderQualityInfo { isLoqNudgeAllowed isLoqForceSchedule __typename }
  ...InvalidItemsFragment
  ...ConsumerOrderCartDomainFragment
  __typename
}

fragment ConsumerOrdersFragment on Order {
  id
  consumer {
    firstName lastName id
    localizedNames { informalName formalName formalNameAbbreviated __typename }
    __typename
  }
  isSubCartFinalized splitBillSubcartStatus
  lineItems { ...LineItemFragment __typename }
  orderItems {
    __typename id
    options { id name quantity nestedOptions __typename }
    itemLevelDiscount { promoId promoCode externalCampaignId __typename }
    cartItemStatusType nestedOptions specialInstructions substitutionPreference
    quantity singlePrice priceOfTotalQuantity priceDisplayString
    nonDiscountPriceDisplayString continuousQuantity unit purchaseType
    estimatedPricingDescription isPrescriptionItem
    increment { decimalPlaces unitAmount __typename }
    discounts { ...OrderItemDiscountFragment __typename }
    item {
      id imageUrl name price minAgeRequirement
      category { title __typename }
      extras { id title description __typename }
      itemTagsList { tagType localizedName shortName id description displayType __typename }
      storeId __typename
    }
    bundleStore { ...OrderItemBundleFragment __typename }
    giftInfo { ...CartItemGiftInfoFragment __typename }
    badges { ...BadgeFragment __typename }
    nudgeList { ...NudgeFragment __typename }
    promoNudgeList { ...PromoNudgeFragment __typename }
    itemLimitData { ...ItemLimitDataFragment __typename }
  }
  paymentCard { id stripeId __typename }
  paymentLineItems { subtotal taxAmount subtotalTaxAmount feesTaxAmount serviceFee __typename }
  __typename
}

fragment LineItemFragment on LineItem {
  label labelIcon discountIcon chargeId
  finalMoney { unitAmount displayString __typename }
  originalMoney { unitAmount displayString __typename }
  tooltip { title paragraphs { description __typename } __typename }
  note __typename
}

fragment OrderItemDiscountFragment on OrderItemDiscount {
  id
  finalMoney { ...DiscountMonetaryFieldsFragment __typename }
  badges { ...BadgeFragment __typename }
  adsMetadata { ...DiscountAdsMetadataFragment __typename }
  __typename
}

fragment DiscountMonetaryFieldsFragment on AmountMonetaryFields {
  currency displayString decimalPlaces unitAmount sign __typename
}

fragment DiscountAdsMetadataFragment on AdsMetadata {
  campaignId adGroupId auctionId __typename
}

fragment OrderItemBundleFragment on OrderItemBundleStore {
  id name businessId isPrimary isRetail __typename
}

fragment CartItemGiftInfoFragment on CartItemGiftInfo {
  recipientName recipientPhone recipientEmail cardMessage senderName
  imageId imageUrl deliveryChannel __typename
}

fragment BadgeFragment on Badge {
  isDashpass type text backgroundColor styleType dlsTagSize dlsTextStyle
  dlsTagStyle dlsTagType placement leadingIcon leadingIconSize trailingIcon
  trailingIconSize endTime dlsTextColor
  brandedDecorator { prefixText postfixText postfixTextLeadingIcon __typename }
  trailingText { copy dlsTextStyle dlsTextColor __typename }
  onClick __typename
}

fragment NudgeFragment on Nudge {
  nudgeMessage { text icon color textStyle __typename }
  progress collectionModalDeeplink __typename
}

fragment PromoNudgeFragment on PromoNudge {
  ... on AddItemNudge {
    nudgeMessage { text icon color __typename }
    collectionModalDeeplink progress __typename
  }
  ... on ClipCouponNudge {
    nudgeMessage { text icon color __typename }
    buttonText incentiveId __typename
  }
  __typename
}

fragment ItemLimitDataFragment on ItemLimitData { limit __typename }

fragment InvalidItemsFragment on OrderCart {
  invalidItems {
    itemId storeId
    itemQuantityInfo {
      discreteQuantity { quantity unit __typename }
      continuousQuantity { quantity unit __typename }
      __typename
    }
    name itemExtrasList menuId __typename
  }
  __typename
}

fragment CheckoutOrderTimeAvailabilityFragment on OrderTimeAvailability {
  scheduleLongerInAdvanceTime timezone
  days {
    year month date
    times { display timestamp min max displayString displayStringDeliveryWindow displayStringSubtitle __typename }
    title subtitle isSelected isDisabled __typename
  }
  __typename
}

fragment ConsumerOrderCartDomainFragment on OrderCart {
  domain {
    giftInfo {
      recipientName recipientGivenName recipientFamilyName recipientPhone
      recipientEmail cardMessage cardId
      shouldNotifyTrackingToRecipientOnDasherAssign
      shouldNotifyRecipientForDasherQuestions senderName
      shouldRecipientScheduleGift hasGiftIntent __typename
    }
    __typename
  }
  __typename
}`;

// ---------------------------------------------------------------------------
// DROPOFF_OPTIONS_QUERY
// ---------------------------------------------------------------------------

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

export const DROPOFF_OPTIONS_QUERY = `
query dropoffOptions($cartId: ID, $addressId: ID) {
  dropoffOptions(cartId: $cartId, addressId: $addressId) {
    id displayString isDefault isEnabled placeholderText disabledMessage
    proofOfDeliveryType __typename
  }
}`;

// ---------------------------------------------------------------------------
// CREATE_ORDER_FROM_CART_QUERY
// ---------------------------------------------------------------------------

export const CREATE_ORDER_FROM_CART_QUERY = `
mutation createOrderFromCart($cartId: ID!, $total: Int!, $sosDeliveryFee: Int!, $isPickupOrder: Boolean!, $verifiedAgeRequirement: Boolean!, $deliveryTime: String!, $menuOptions: [String], $stripeToken: String, $attributionData: String, $fulfillsOwnDeliveries: Boolean, $budgetId: String, $teamId: String, $giftOptions: GiftOptionsInput, $recipientShippingDetails: RecipientShippingDetails, $storeId: String, $tipAmounts: [TipAmount!], $paymentMethod: Int, $deliveryOptionType: DeliveryOptionType, $workOrderOptions: WorkOrderOptionsInput, $isCardPayment: Boolean, $clientFraudContext: PaymentClientFraudContextInput, $programId: String, $membershipId: String, $dropoffPreferences: String, $routineReorderDetails: RoutineReorderDetails, $supplementalPaymentDetailsList: [SupplementalPaymentDetails!], $monitoringContext: CreateOrderFromCartMonitoringContextInput, $rewardBalanceApplied: RewardBalanceDetailsInput, $deliveryOptionInfo: DeliveryOptionInfo, $hasAccessibilityRequirements: Boolean, $shouldApplyCredits: Boolean, $dasherPickupInstructions: String, $paymentMethodUuid: String, $paymentMethodType: PaymentMethodType, $deviceTimezone: String, $paymentMethodBrand: String, $submitPlatform: String) {
  createOrderFromCart(
    cartId: $cartId
    total: $total
    sosDeliveryFee: $sosDeliveryFee
    isPickupOrder: $isPickupOrder
    verifiedAgeRequirement: $verifiedAgeRequirement
    deliveryTime: $deliveryTime
    menuOptions: $menuOptions
    stripeToken: $stripeToken
    attributionData: $attributionData
    fulfillsOwnDeliveries: $fulfillsOwnDeliveries
    budgetId: $budgetId
    teamId: $teamId
    giftOptions: $giftOptions
    recipientShippingDetails: $recipientShippingDetails
    storeId: $storeId
    tipAmounts: $tipAmounts
    paymentMethod: $paymentMethod
    deliveryOptionType: $deliveryOptionType
    workOrderOptions: $workOrderOptions
    isCardPayment: $isCardPayment
    clientFraudContext: $clientFraudContext
    programId: $programId
    membershipId: $membershipId
    dropoffPreferences: $dropoffPreferences
    routineReorderDetails: $routineReorderDetails
    supplementalPaymentDetailsList: $supplementalPaymentDetailsList
    monitoringContext: $monitoringContext
    rewardBalanceApplied: $rewardBalanceApplied
    deliveryOptionInfo: $deliveryOptionInfo
    hasAccessibilityRequirements: $hasAccessibilityRequirements
    shouldApplyCredits: $shouldApplyCredits
    dasherPickupInstructions: $dasherPickupInstructions
    paymentMethodUuid: $paymentMethodUuid
    paymentMethodType: $paymentMethodType
    deviceTimezone: $deviceTimezone
    paymentMethodBrand: $paymentMethodBrand
    submitPlatform: $submitPlatform
  ) {
    cartId
    orderUuid
    isFirstOrderCart
    isFirstNewVerticalsOrderCart
    __typename
  }
}`;

// ---------------------------------------------------------------------------
// PAYMENT_METHODS_QUERY
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// UPDATE_CART_ITEM_QUERY (used for retail/convenience stores instead of addCartItem)
// ---------------------------------------------------------------------------

export const UPDATE_CART_ITEM_QUERY = `
mutation updateCartItem($updateCartItemApiParams: UpdateCartItemInput!, $fulfillmentContext: FulfillmentContextInput!, $returnCartFromOrderService: Boolean, $shouldKeepOnlyOneActiveCart: Boolean, $cartContextFilter: CartContextV2) {
  updateCartItemV2(
    updateCartItemInput: $updateCartItemApiParams
    fulfillmentContext: $fulfillmentContext
    returnCartFromOrderService: $returnCartFromOrderService
    shouldKeepOnlyOneActiveCart: $shouldKeepOnlyOneActiveCart
    cartContextFilter: $cartContextFilter
  ) {
    ...ConsumerOrderCartFragment
    __typename
  }
}

${/* Re-use the same ConsumerOrderCartFragment from ADD_CART_ITEM_QUERY */''}
fragment ConsumerOrderCartFragment on OrderCart {
  id hasError cartType isConsumerPickup isConvenienceCart isPrescriptionDelivery
  prescriptionStoreInfo { retailStoreId __typename }
  isMerchantShipping offersDelivery offersPickup subtotal urlCode
  groupCart groupCartType groupCartSource groupCartPollInterval
  scheduledDeliveryAvailable isCatering isSameStoreCatering isBundle bundleType
  fulfillmentType originalBundleOrderCartId cartStatusType
  shortenedUrl maxIndividualCost serviceRateMessage isOutsideDeliveryRegion
  currencyCode asapMinutesRange
  menu { id hoursToOrderInAdvance name minOrderSize isCatering __typename }
  creator {
    id firstName lastName
    localizedNames { informalName formalName formalNameAbbreviated __typename }
    __typename
  }
  deliveries { id quotedDeliveryTime __typename }
  submittedAt
  restaurant {
    id name maxOrderSize coverImgUrl slug
    address { printableAddress street lat lng __typename }
    business { id name __typename }
    orderProtocol idealGroupSize highQualitySubtotalThreshold __typename
  }
  orders { ...ConsumerOrdersFragment __typename }
  total totalBeforeDiscountsAndCredits
  footerDetails { title subtitle __typename }
  outOfStockMenuItemIds
  __typename
}

fragment ConsumerOrdersFragment on Order {
  id
  consumer {
    firstName lastName id
    localizedNames { informalName formalName formalNameAbbreviated __typename }
    __typename
  }
  orderItems {
    __typename id
    options { id name quantity nestedOptions __typename }
    cartItemStatusType nestedOptions specialInstructions substitutionPreference
    quantity singlePrice priceOfTotalQuantity priceDisplayString
    item {
      id imageUrl name price
      category { title __typename }
      storeId __typename
    }
    __typename
  }
  paymentCard { id stripeId __typename }
  __typename
}`;

export const PAYMENT_METHODS_QUERY = `
query paymentMethodQuery {
  getPaymentMethodList {
    id
    type
    last4
    isDefault
    paymentMethodUuid
    __typename
  }
}`;
