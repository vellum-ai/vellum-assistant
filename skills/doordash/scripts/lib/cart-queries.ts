/**
 * GraphQL queries for DoorDash cart operations: add, remove, update, list, and detail.
 * Each query is fully self-contained with all required fragment definitions.
 */

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
