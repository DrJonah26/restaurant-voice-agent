import { NextResponse } from "next/server"
import { requireAuth } from "@/lib/auth-helpers"
import { prisma } from "@/lib/prisma"

export async function POST(request: Request) {
  try {
    const session = await requireAuth()
    const data = await request.json()

    const {
      restaurantName,
      size,
      tableCount,
      seatCount,
      phoneNumber,
      language,
      openingHours,
    } = data

    // Prüfe ob bereits ein Restaurant existiert
    const existingRestaurant = await prisma.restaurant.findUnique({
      where: { userId: session.user.id },
    })

    if (existingRestaurant) {
      // Update existing restaurant
      await prisma.restaurant.update({
        where: { id: existingRestaurant.id },
        data: {
          name: restaurantName,
          size,
          tableCount,
          seatCount,
          phoneNumber: phoneNumber || null,
          language,
        },
      })

      // Update opening hours
      await prisma.openingHours.deleteMany({
        where: { restaurantId: existingRestaurant.id },
      })

      await prisma.openingHours.createMany({
        data: openingHours.map((oh: any) => ({
          restaurantId: existingRestaurant.id,
          dayOfWeek: oh.dayOfWeek,
          openTime: oh.openTime,
          closeTime: oh.closeTime,
          isClosed: oh.isClosed,
        })),
      })
    } else {
      // Create new restaurant
      const restaurant = await prisma.restaurant.create({
        data: {
          userId: session.user.id,
          name: restaurantName,
          size,
          tableCount,
          seatCount,
          phoneNumber: phoneNumber || null,
          language,
          openingHours: {
            create: openingHours.map((oh: any) => ({
              dayOfWeek: oh.dayOfWeek,
              openTime: oh.openTime,
              closeTime: oh.closeTime,
              isClosed: oh.isClosed,
            })),
          },
        },
      })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("Onboarding error:", error)
    return NextResponse.json(
      { error: "Ein Fehler ist aufgetreten" },
      { status: 500 }
    )
  }
}
