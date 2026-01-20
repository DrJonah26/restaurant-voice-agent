import { redirect } from "next/navigation"
import { requireAuth } from "@/lib/auth-helpers"
import { prisma } from "@/lib/prisma"
import { DashboardClient } from "./dashboard-client"

async function getDashboardData(userId: string) {
  const restaurant = await prisma.restaurant.findUnique({
    where: { userId },
    include: {
      openingHours: true,
      callLogs: {
        orderBy: { createdAt: "desc" },
        take: 10,
      },
      reservations: {
        orderBy: { reservationDate: "asc" },
        take: 10,
      },
    },
  })

  if (!restaurant) {
    return null
  }

  const totalCalls = await prisma.callLog.count({
    where: { restaurantId: restaurant.id },
  })

  const successfulReservations = await prisma.callLog.count({
    where: {
      restaurantId: restaurant.id,
      result: "reserved",
    },
  })

  const missedCalls = await prisma.callLog.count({
    where: {
      restaurantId: restaurant.id,
      result: "missed",
    },
  })

  const rejectedCalls = await prisma.callLog.count({
    where: {
      restaurantId: restaurant.id,
      result: "rejected",
    },
  })

  const upcomingReservations = await prisma.reservation.count({
    where: {
      restaurantId: restaurant.id,
      status: "confirmed",
      reservationDate: {
        gte: new Date(),
      },
    },
  })

  return {
    restaurant,
    stats: {
      totalCalls,
      successfulReservations,
      missedCalls,
      rejectedCalls,
      upcomingReservations,
    },
  }
}

export default async function DashboardPage() {
  const session = await requireAuth()
  const data = await getDashboardData(session.user.id)

  if (!data) {
    redirect("/onboarding")
  }

  return <DashboardClient initialData={data} />
}
